// api/nowpayments-webhook.js
const crypto = require('crypto');
const axios = require('axios');
const nodemailer = require('nodemailer');

const {
  NOW_IPN_SECRET,
  SHIPENGINE_API_KEY,
  ADMIN_EMAIL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS
} = process.env;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT ? parseInt(SMTP_PORT) : 587,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

function verifyNowSignature(rawBody, headerSig) {
  // NOWPayments requires: sort payload keys alphabetically, JSON.stringify with sorted keys,
  // then HMAC-SHA512 using IPN secret. Header is x-nowpayments-sig
  try {
    const obj = JSON.parse(rawBody);
    const sortedKeys = Object.keys(obj).sort();
    const sortedObj = {};
    sortedKeys.forEach(k => { sortedObj[k] = obj[k]; });
    const jsonString = JSON.stringify(sortedObj);
    const hmac = crypto.createHmac('sha512', NOW_IPN_SECRET || '');
    hmac.update(jsonString);
    const digest = hmac.digest('hex');
    return digest === (headerSig || '').toString();
  } catch (e) {
    console.error('verify error', e);
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  // Vercel parses JSON automatically - we need raw body to verify signature.
  // When using Vercel, raw body isn't available by default. However their serverless receives parsed body.
  // To ensure signature verification, set raw body passthrough in advanced setups.
  // For most tests, we'll use the parsed object but re-stringify sorted - okay for now.
  const headerSig = req.headers['x-nowpayments-sig'] || req.headers['X-Nowpayments-Sig'] || '';

  const rawBody = JSON.stringify(req.body); // We will sort inside verify function.
  const ok = verifyNowSignature(rawBody, headerSig);

  if (!ok) {
    console.warn('NOWPayments signature invalid!');
    return res.status(400).send('invalid signature');
  }

  // NOWPayments payload fields vary; we guard for common ones:
  const payload = req.body;
  const status = payload.status || payload.payment_status;
  const orderId = payload.order_id || payload.id;
  const amount = parseFloat(payload.price_amount || payload.amount || 0); // amount in currency of the invoice
  const currency = payload.price_currency || payload.currency || 'EUR';
  const customerEmail = payload.buyer_email || payload.customer_email || '';

  console.log('NOWPayments webhook received:', orderId, status);

  // we only act when payment finished/confirmed
  if (!['finished', 'confirmed'].includes(String(status))) {
    return res.status(200).send('ignored - not finished');
  }

  // Bereken marge en label-amount (10%)
  const total = amount;
  const margin = +(total * 0.10).toFixed(2);
  const labelAmount = +(total - margin).toFixed(2);

  // TODO: in productie: check je ShipEngine-saldo via admin of DB
  // Voor nu gaan we proberen direct een label aan te maken (zorg dat je saldo hebt)
  // Simpel voorbeeld payload voor ShipEngine (pas aan met echte data)
  const shipmentData = {
    shipment: {
      validate_address: false,
      service_code: 'ups_ground', // pas aan naar gewenste carrier/service
      ship_to: {
        name: payload.to_name || 'Ontvanger',
        phone: payload.to_phone || '',
        address_line1: payload.to_address || 'Straat 1',
        city_locality: payload.to_city || 'City',
        postal_code: payload.to_postal || '0000AA',
        country_code: payload.to_country || 'NL'
      },
      ship_from: {
        name: payload.from_name || 'Afzender',
        phone: payload.from_phone || '',
        address_line1: payload.from_address || 'Jouw Straat 1',
        city_locality: payload.from_city || 'Jouw Stad',
        postal_code: payload.from_postal || '0000AA',
        country_code: payload.from_country || 'NL'
      },
      packages: [
        { weight: { value: 1, unit: 'pound' } }
      ]
    }
  };

  try {
    // Vraag label aan bij ShipEngine
    const seResp = await axios.post('https://api.shipengine.com/v1/labels', shipmentData, {
      headers: {
        'Content-Type': 'application/json',
        'API-Key': SHIPENGINE_API_KEY
      },
      timeout: 15000
    });

    const labelUrl = seResp?.data?.label_download?.href || seResp?.data?.pdf_url || null;

    // Mail label naar klant
    const mailTo = customerEmail || ADMIN_EMAIL;
    await transporter.sendMail({
      from: `no-reply@${process.env.VERCEL_URL || 'yourdomain.com'}`,
      to: mailTo,
      subject: `Je verzendlabel — order ${orderId}`,
      text: labelUrl ? `Hier is je label: ${labelUrl}` : 'Label is aangemaakt, maar link ontbreekt.',
      html: labelUrl ? `<p>Je label is <a href="${labelUrl}">hier</a>.</p>` : `<p>Label is aangemaakt, maar link ontbreekt.</p>`
    });

    console.log(`Order ${orderId} processed; margin ${margin} ${currency}; label ${labelAmount} ${currency}`);
    return res.status(200).send('ok');
  } catch (err) {
    console.error('ShipEngine/error', err?.response?.data || err.message || err);
    // mail admin dat er iets fout ging
    await transporter.sendMail({
      from: `no-reply@${process.env.VERCEL_URL || 'yourdomain.com'}`,
      to: ADMIN_EMAIL,
      subject: `Fout bij order ${orderId}`,
      text: `Er ging iets mis bij order ${orderId}: ${err?.message || 'unknown'}`
    });
    return res.status(500).send('label error');
  }
};
