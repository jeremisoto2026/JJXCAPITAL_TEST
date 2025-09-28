import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc } from "firebase/firestore";
import Binance from "node-binance-api";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json()); // ✅ Reemplaza body-parser

// === Firebase ===
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// === Binance ===
const client = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET
});

// ✅ Ruta de prueba para verificar servidor
app.get("/ping", (req, res) => {
  res.json({ status: "Servidor activo ✅" });
});

// Ruta test Firebase
app.post("/save", async (req, res) => {
  try {
    const { mensaje } = req.body;

    if (!mensaje) {
      return res.status(400).json({ success: false, error: "El campo 'mensaje' es obligatorio" });
    }

    const docRef = await addDoc(collection(db, "mensajes"), {
      mensaje,
      fecha: new Date()
    });

    res.json({ success: true, id: docRef.id });
  } catch (err) {
    console.error("❌ Error Firebase:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ruta test Binance (saldo spot con logs)
app.get("/balance", (req, res) => {
  console.log("➡️ Entrando a /balance...");
  console.log("🔑 APIKEY:", process.env.BINANCE_API_KEY ? "Cargada ✅" : "NO cargada ❌");
  console.log("🔑 APISECRET:", process.env.BINANCE_API_SECRET ? "Cargada ✅" : "NO cargada ❌");

  client.balance((error, balances) => {
    if (error) {
      console.error("❌ Error Binance:", error);
      return res.status(500).json({ error: error.body || error.message });
    }
    console.log("✅ Balances Binance:", balances);
    res.json(balances);
  });
});

// Levantar servidor
const PORT = process.env.PORT || 8080; // ⚡ Railway usa 8080
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));