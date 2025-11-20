// utils.js
import crypto from "crypto";
import fs from "fs-extra";
import { createClient } from "@supabase/supabase-js";

export function computeHmacHex(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export async function readDataFile(path) {
  try {
    if (!await fs.pathExists(path)) {
      await fs.writeJson(path, { nodes: {}, alerts: [] }, { spaces: 2 });
    }
    return await fs.readJson(path);
  } catch (err) {
    console.error("readDataFile error:", err);
    return { nodes: {}, alerts: [] };
  }
}

export async function writeDataFile(path, obj) {
  try {
    await fs.writeJson(path, obj, { spaces: 2 });
  } catch (err) {
    console.error("writeDataFile error:", err);
  }
}

// Supabase helper: init client
export function initSupabase(url, key) {
  return createClient(url, key, { auth: { persistSession: false } });
}

// Example computation functions required by server:
export function computeHeatIndex(T, RH) {
  // Simple NOAA formula approximate (T in C) -- convert to F for formula
  const T_F = (T * 9/5) + 32;
  const HI_F = -42.379 + 2.04901523*T_F + 10.14333127*RH - 0.22475541*T_F*RH - 6.83783e-3*T_F*T_F - 5.481717e-2*RH*RH + 1.22874e-3*T_F*T_F*RH + 8.5282e-4*T_F*RH*RH - 1.99e-6*T_F*T_F*RH*RH;
  const HI_C = (HI_F - 32) * 5/9;
  return Math.round(HI_C*10)/10;
}

export function computeDewPoint(T, RH) {
  // Magnus formula
  const a = 17.27, b = 237.7;
  const alpha = ((a * T) / (b + T)) + Math.log(RH/100);
  const dp = (b * alpha) / (a - alpha);
  return Math.round(dp*10)/10;
}

export function computeVPD(T, RH) {
  // VPD = es(T) - ea(T,RH) ; es = 0.611*exp(17.27*T/(T+237.3))
  const es = 0.611 * Math.exp((17.27 * T) / (T + 237.3));
  const ea = es * (RH/100);
  const vpd = es - ea; // kPa
  return Math.round(vpd*100)/100; // two decimals
}

// A simple PFFI approximator (weights can be tuned)
export function computePFFI({temp_c, hum_pct, mq2, mq135, flame1, flame2, sound_confidence}) {
  const tf = Math.max(0, Math.min(1, (temp_c - 15)/25)); // normalized
  const hf = 1 - Math.max(0, Math.min(1, (hum_pct - 10)/90));
  const smoke = Math.max(0, Math.min(1, mq2 / 500)); // scale
  const gas = Math.max(0, Math.min(1, mq135 / 500));
  const flame = flame1 || flame2 ? 1 : 0;
  const sound = (sound_confidence || 0)/100;

  const raw = (tf*0.25) + (hf*0.2) + (smoke*0.25) + (gas*0.1) + (flame*0.15) + (sound*0.1);
  return Math.round(Math.min(1, raw) * 100);
}

