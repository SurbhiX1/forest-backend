import crypto from "crypto";
import fs from "fs";

const secret = "17surbhi";   // Must match your .env EXACTLY

// Load payload
const payload = fs.readFileSync("payload.json", "utf8");

// Generate HMAC SHA256
const signature = crypto
  .createHmac("sha256", secret)
  .update(payload)
  .digest("hex");

console.log("Signature:", signature);
