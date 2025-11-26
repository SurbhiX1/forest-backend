import express from "express";
import crypto from "crypto";
import cors from "cors";
import bodyParser from "body-parser";
import { supabase } from "./utils.js";

const app = express();
app.use(cors());

// -----------------------------
// 1. RAW BODY CAPTURE (Required for HMAC)
// -----------------------------
let rawBodyBuffer;
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      rawBodyBuffer = buf.toString("utf8"); // store raw JSON string
    },
  })
);

// -----------------------------
// 2. DEVICE SECRETS (EDIT THIS)
// -----------------------------
// IMPORTANT: update these to match the DEVICE_SECRET on each sender node
const DEVICE_SECRETS = {
  "node_01": "17surbhi",     // your sender node
  // "node_02": "anotherSecret",
};

// -----------------------------
// 3. HMAC FUNCTION
// -----------------------------
function computeHmacHex(secret, data) {
  return crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("hex");
}

// -----------------------------
// 4. INGEST API
// -----------------------------
app.post("/ingest", async (req, res) => {
  try {
    const deviceId = req.headers["x-device-id"];
    const receivedSig = req.headers["x-signature"];

    if (!deviceId)
      return res.status(400).json({ error: "missing deviceId" });

    if (!receivedSig)
      return res.status(400).json({ error: "missing signature" });

    const secret = DEVICE_SECRETS[deviceId];
    if (!secret)
      return res.status(401).json({ error: "Unknown deviceId" });

    if (!rawBodyBuffer)
      return res.status(400).json({ error: "Empty raw body" });

    // Verify HMAC
    const expectedSig = computeHmacHex(secret, rawBodyBuffer);

    if (expectedSig !== receivedSig) {
      return res.status(401).json({
        error: "invalid signature",
        expected: expectedSig,
        received: receivedSig,
      });
    }

    // VALID BODY
    const payload = req.body;

    // (Optional) Validate required keys
    const required = [
      "zoneId",
      "nodeId",
      "temp_c",
      "hum_pct",
      "mq2",
      "mq135",
      "flame1",
      "flame2",
      "dB",
      "battery_pct",
      "timestamp",
    ];

    for (const key of required) {
      if (!(key in payload)) {
        return res.status(400).json({ error: `Missing key: ${key}` });
      }
    }

    // -----------------------------
    // 5. STORE INTO SUPABASE
    // -----------------------------
    const { error } = await supabase.from("forest_telemetry").insert(payload);

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ error: "DB insert failed" });
    }

    return res.json({ status: "ok", stored: true });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// -----------------------------
// 6. START SERVER
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
