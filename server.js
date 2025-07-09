import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/verify', async (req, res) => {
  const { email, key } = req.query;

  if (!email || !key) {
    return res.status(400).json({ error: "Missing email or key" });
  }

  const url = `https://verify.gmass.co/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}`;

  try {
    const gmassRes = await fetch(url);
    const text = await gmassRes.text();
    res.status(200).send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ GMass Proxy running on http://localhost:${PORT}`);
});