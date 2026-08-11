/**
 * Boke Tours and Travel — M-Pesa STK Push backend
 * -------------------------------------------------
 * This is the piece that MUST live on a server, never in the browser,
 * because it needs your Daraja consumer key/secret and passkey.
 *
 * Setup:
 *   1. npm init -y
 *   2. npm install express axios dotenv cors
 *   3. Create a .env file (see below) with your Daraja credentials
 *   4. node server.js
 *
 * .env file:
 *   MPESA_CONSUMER_KEY=your_consumer_key
 *   MPESA_CONSUMER_SECRET=your_consumer_secret
 *   MPESA_SHORTCODE=your_paybill_or_till_number      // 174379 for sandbox
 *   MPESA_PASSKEY=your_lipa_na_mpesa_passkey
 *   MPESA_ENV=sandbox                                 // or "production"
 *   CALLBACK_URL=https://yourdomain.com/api/mpesa/callback
 *   PORT=4000
 *
 * Get sandbox credentials at https://developer.safaricom.co.ke
 * (Test Credentials -> Lipa Na M-Pesa Online).
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Serves everything in /public — including index.html (your inquiry form)
// at the root URL, e.g. http://localhost:4000 or https://bokentours.com
app.use(express.static('public'));

const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_ENV,
  CALLBACK_URL,
  PORT
} = process.env;

const BASE_URL = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// In-memory store for demo purposes — swap for a real database in production.
const inquiries = new Map();

function timestampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

async function getAccessToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return data.access_token;
}

// 1. Client submits the inquiry form -> we trigger an STK push
app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { phone, amount, accountReference, inquiry } = req.body;

    if (!/^254[17]\d{8}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number format.' });
    }
    if (!amount || amount < 1) {
      return res.status(400).json({ success: false, message: 'Invalid amount.' });
    }

    const token = await getAccessToken();
    const timestamp = timestampNow();
    const password = Buffer.from(
      `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline', // use CustomerBuyGoodsOnline for a Till number
      Amount: amount,
      PartyA: phone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: CALLBACK_URL,
      AccountReference: accountReference || 'BOKE-TOURS',
      TransactionDesc: 'Boke Tours deposit payment'
    };

    const { data } = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Stash the inquiry + checkout ID so we can reconcile it in the callback
    if (data.CheckoutRequestID) {
      inquiries.set(data.CheckoutRequestID, { ...inquiry, phone, amount, status: 'pending' });
    }

    res.json(data); // contains ResponseCode, CheckoutRequestID, CustomerMessage, etc.
  } catch (err) {
    console.error('STK push error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Could not reach Safaricom. Please try again.' });
  }
});

// 2. Safaricom calls this URL asynchronously once the customer enters their PIN
//    (CALLBACK_URL above must be a public HTTPS URL — use ngrok while testing locally)
app.post('/api/mpesa/callback', (req, res) => {
  const result = req.body?.Body?.stkCallback;
  if (!result) return res.sendStatus(400);

  const record = inquiries.get(result.CheckoutRequestID);

  if (result.ResultCode === 0) {
    const meta = Object.fromEntries(
      (result.CallbackMetadata?.Item || []).map((i) => [i.Name, i.Value])
    );
    console.log('Payment received:', meta);
    if (record) {
      record.status = 'paid';
      record.mpesaReceipt = meta.MpesaReceiptNumber;
      // TODO: send confirmation email/SMS to the client, notify Boke Tours staff
    }
  } else {
    console.log('Payment failed or cancelled:', result.ResultDesc);
    if (record) record.status = 'failed';
  }

  res.sendStatus(200); // Safaricom just needs a 200 acknowledgment
});

// 3. (Optional) frontend can poll this to check whether payment cleared
app.get('/api/mpesa/status/:checkoutRequestId', (req, res) => {
  const record = inquiries.get(req.params.checkoutRequestId);
  if (!record) return res.status(404).json({ status: 'unknown' });
  res.json(record);
});

app.listen(PORT || 4000, () => {
  console.log(`M-Pesa backend running on port ${PORT || 4000}`);
});
