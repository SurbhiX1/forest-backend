import express from "express";
import cors from "cors";
import crypto from "crypto";
import { supabase } from "./utils.js";

const app = express();
app.use(cors());
app.use(express.json());

// Validate signature EXACTLY like ESP32
function verifySignature(secret, compactPayload, signature) {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(JSON.stringify(compactPayload));
  const expected = hmac.digest("hex");
  return { ok: expected === signature, expected };
}

const DEVICE_SECRET = "17surbhi";

app.post("/ingest", async (req, res) => {
  console.log("Received body:", req.body);

  const envelope = req.body;

  if (!envelope.p || !envelope.d || !envelope.s)
    return res.status(400).json({ error: "Invalid packet structure" });

  const compactPayload = envelope.p;
  const deviceId = envelope.d;
  const signature = envelope.s;

  // Verify signature
  const result = verifySignature(DEVICE_SECRET, compactPayload, signature);

  if (!result.ok)
    return res.status(401).json({
      error: "invalid signature",
      expected: result.expected,
      received: signature,
    });

  // Expand compact payload for database
  const fullPayload = {
    zone_id: compactPayload.z,
    node_id: compactPayload.id,
    temp_c: compactPayload.t,
    hum_pct: compactPayload.h,
    mq2: compactPayload.g1,
    mq135: compactPayload.g2,
    flame1: compactPayload.f1,
    flame2: compactPayload.f2,
    db: compactPayload.db,
    battery_pct: compactPayload.b,
    ts: compactPayload.ts,
  };

  // Insert into Supabase
  const { data, error } = await supabase
    .from("forest_telemetry")
    .insert([{ 
    ...fullPayload,
    received_at: new Date().toISOString()
}]);


  if (error) return res.status(500).json({ error });

  res.json({ status: "ok", stored: true });
});

// Default route
app.get("/", (req, res) => res.send("Forest backend running"));

app.listen(3000, () => console.log("Backend running on port 3000"));

