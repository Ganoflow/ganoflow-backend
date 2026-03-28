const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();

app.use(cors({ origin: ['https://ganoflow.com'], credentials: true }));
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
app.use(express.json());

const PLANS = {
  basic:    { name: 'Basic',    priceId: { monthly: process.env.STRIPE_BASIC_MONTHLY_PRICE_ID    } },
  standard: { name: 'Standard', priceId: { monthly: process.env.STRIPE_STANDARD_MONTHLY_PRICE_ID } },
  premium:  { name: 'Premium',  priceId: { monthly: process.env.STRIPE_PREMIUM_MONTHLY_PRICE_ID  } },
};

app.post('/create-checkout-session', async (req, res) => {
  const { email, planKey } = req.body;
  if (!email || !planKey) return res.status(400).json({ error: 'email and planKey required' });
  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });
  try {
    const customer = await stripe.customers.create({ email });
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [{ price: plan.priceId.monthly, quantity: 1 }],
      mode: 'subscription',
      success_url: `https://ganoflow.com?subscribed=true&plan=${planKey}`,
      cancel_url: `https://ganoflow.com/#pricing`,
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log(`Webhook: ${event.type}`);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  res.json({ received: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`GanoFlow backend running on port ${PORT}`));
