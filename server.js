// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { computeHmacHex, readDataFile, writeDataFile, initSupabase, computePFFI, computeVPD, computeDewPoint, computeHeatIndex } from "./utils.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DEVICE_SECRET = process.env.DEVICE_SECRET || "17surbhi";
const DATA_FILE = process.env.DATA_FILE || "data.json";

// Supabase init
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("Supabase env vars missing. Set SUPABASE_URL and SUPABASE_KEY.");
  process.exit(1);
}
const supabase = initSupabase(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '256kb' }));

// Serve dashboard static if you place frontend in ../dashboard
app.use("/", express.static(path.join(__dirname, "../dashboard")));

// Load in-memory file
let store = { nodes: {}, alerts: [] };
(async ()=> { store = await readDataFile(path.join(process.cwd(), DATA_FILE)); })();

async function persist() {
  await writeDataFile(path.join(process.cwd(), DATA_FILE), store);
}

/**
 * POST /ingest
 * headers:
 *  x-device-id: node_01
 *  x-signature: hmac_sha256_hex_of_body_using_DEVICE_SECRET
 *
 * body: JSON with fields:
 *  zoneId, nodeId, temp_c, hum_pct, mq2, mq135, flame1, flame2, dB, sound_type, sound_confidence, battery_pct, timestamp
 */
app.post("/ingest", async (req, res) => {
  try {
    const sig = req.headers["x-signature"];
    const deviceIdHeader = req.headers["x-device-id"] || req.headers["device-id"];

    if (!sig || !deviceIdHeader) return res.status(400).json({ error: "missing headers" });

    const raw = JSON.stringify(req.body);
    const expected = computeHmacHex(DEVICE_SECRET, raw);
    if (expected !== sig) return res.status(401).json({ error: "invalid signature" });

    // Validate minimal fields
    const b = req.body;
    const required = ["zoneId","nodeId","temp_c","hum_pct","mq2","mq135","flame1","flame2","dB","timestamp"];
    for (const k of required) if (typeof b[k] === "undefined") return res.status(400).json({ error: `missing ${k}` });

    // compute derived metrics
    const temp_c = Number(b.temp_c);
    const hum_pct = Number(b.hum_pct);
    const dp = computeDewPoint(temp_c, hum_pct);
    const vpd = computeVPD(temp_c, hum_pct);
    const hi = computeHeatIndex(temp_c, hum_pct);
    const pffi = computePFFI({
      temp_c, hum_pct, mq2: Number(b.mq2), mq135: Number(b.mq135),
      flame1: b.flame1, flame2: b.flame2, sound_confidence: b.sound_confidence || 0
    });

    const record = {
      zoneId: b.zoneId,
      nodeId: b.nodeId,
      temp_c,
      hum_pct,
      mq2: Number(b.mq2),
      mq135: Number(b.mq135),
      flame1: b.flame1 ? 1 : 0,
      flame2: b.flame2 ? 1 : 0,
      dB: Number(b.dB),
      sound_type: b.sound_type || null,
      sound_confidence: b.sound_confidence || 0,
      battery_pct: b.battery_pct || null,
      timestamp: Number(b.timestamp),
      computed: { dp, vpd, hi, pffi, received_at: Date.now() }
    };

    // keep in memory
    const key = `${record.zoneId}/${record.nodeId}`;
    store.nodes[key] = store.nodes[key] || { history: [] };
    store.nodes[key].latest = record;
    store.nodes[key].history.push({ timestamp: record.timestamp, temp_c: record.temp_c, pffi: record.computed.pffi, dB: record.dB });
    if (store.nodes[key].history.length > 500) store.nodes[key].history.shift();

    // create alert if needed
    if (record.computed.pffi >= 80 || record.flame1 || record.flame2 || record.dB >= 100) {
      const alert = { id: `a_${Date.now()}`, zoneId: record.zoneId, nodeId: record.nodeId, pffi: record.computed.pffi, dB: record.dB, sound_type: record.sound_type, timestamp: Date.now(), acknowledged: false, type: (record.flame1||record.flame2) ? "fire" : "warning" };
      store.alerts.unshift(alert);
      if (store.alerts.length > 300) store.alerts.pop();
    }

    // persist locally
    persist().catch(e => console.error(e));

    // write to Supabase (table: forest_telemetry)
    // use upsert style: insert new row
    const supaRow = {
      zone_id: record.zoneId,
      node_id: record.nodeId,
      temp_c: record.temp_c,
      hum_pct: record.hum_pct,
      mq2: record.mq2,
      mq135: record.mq135,
      flame1: record.flame1,
      flame2: record.flame2,
      db: record.dB,
      sound_type: record.sound_type,
      sound_confidence: record.sound_confidence,
      battery_pct: record.battery_pct,
      dp: record.computed.dp,
      vpd: record.computed.vpd,
      hi: record.computed.hi,
      pffi: record.computed.pffi,
      ts: new Date(record.timestamp * 1000).toISOString()
    };

    const { data, error } = await supabase.from("forest_telemetry").insert([supaRow]);
    if (error) console.error("Supabase insert error:", error);

    // Send response
    res.json({ ok: true, pffi: record.computed.pffi });

  } catch (err) {
    console.error("ingest err", err);
    res.status(500).json({ error: "server error" });
  }
});

// Endpoint to get last known state (dashboard can poll)
app.get("/api/status", (req, res) => {
  res.json(store);
});

// Endpoint to get last N telemetry rows (from supabase)
app.get("/api/history/:limit?", async (req, res) => {
  const limit = Number(req.params.limit || 200);
  const { data, error } = await supabase.from("forest_telemetry").select("*").order("ts", { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ack alert
app.post("/api/alerts/:id/ack", express.json(), (req, res) => {
  const id = req.params.id;
  const a = store.alerts.find(x => x.id === id);
  if (!a) return res.status(404).json({ error: "not found" });
  a.acknowledged = true;
  persist();
  res.json({ ok: true });
});

app.listen(PORT, ()=> console.log(`Forest backend running on ${PORT}`));

