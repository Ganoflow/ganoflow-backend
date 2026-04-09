const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

const CHANNELS = {
  basic:    process.env.TG_BASIC_CHANNEL,
  standard: process.env.TG_STANDARD_CHANNEL,
  premium:  process.env.TG_PREMIUM_CHANNEL,
};

const PLANS = {
  basic:    { name: 'Basic',    priceId: { monthly: process.env.STRIPE_BASIC_MONTHLY_PRICE_ID    } },
  standard: { name: 'Standard', priceId: { monthly: process.env.STRIPE_STANDARD_MONTHLY_PRICE_ID } },
  premium:  { name: 'Premium',  priceId: { monthly: process.env.STRIPE_PREMIUM_MONTHLY_PRICE_ID  } },
};

// ─── TELEGRAM HELPERS ────────────────────────────────────────────────────────

async function tgApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getUserIdByUsername(username) {
  // Remove @ if present
  const clean = username.replace('@', '');
  const res = await tgApi('getChat', { chat_id: `@${clean}` });
  if (res.ok) return res.result.id;
  return null;
}

async function createOneTimeInviteLink(channelId) {
  const res = await tgApi('createChatInviteLink', {
    chat_id: channelId,
    member_limit: 1,  // 1회용
    creates_join_request: false,
  });
  if (res.ok) return res.result.invite_link;
  return null;
}

async function kickUser(channelId, userId) {
  // Ban then immediately unban (removes from channel)
  await tgApi('banChatMember', { chat_id: channelId, user_id: userId });
  await tgApi('unbanChatMember', { chat_id: channelId, user_id: userId });
}

async function sendTelegramMessage(userId, text) {
  await tgApi('sendMessage', { chat_id: userId, text, parse_mode: 'Markdown' });
}

// ─── CHECKOUT ────────────────────────────────────────────────────────────────

app.post('/create-checkout-session', async (req, res) => {
  const { email, planKey, telegramId } = req.body;
  if (!email || !planKey) return res.status(400).json({ error: 'email and planKey required' });
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });

  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const customer = await stripe.customers.create({
      email,
      metadata: { telegramId, planKey },
    });

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [{ price: plan.priceId.monthly, quantity: 1 }],
      mode: 'subscription',
      success_url: `https://ganoflow.com?subscribed=true&plan=${planKey}`,
      cancel_url: `https://ganoflow.com/#pricing`,
      allow_promotion_codes: true,
      metadata: { telegramId, planKey },
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Webhook: ${event.type}`);

  try {
    // ── 결제 성공 → 자동 초대 ──────────────────────────────────────────────
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const telegramId = session.metadata?.telegramId;
      const planKey = session.metadata?.planKey;
      const channelId = CHANNELS[planKey];

      if (telegramId && channelId) {
        // 1회용 초대 링크 생성
        const inviteLink = await createOneTimeInviteLink(channelId);

        if (inviteLink) {
          await sendTelegramMessage(telegramId,
            `✅ *Payment confirmed! Welcome to GanoFlow ${PLANS[planKey]?.name}!*\n\n` +
            `👇 Join your exclusive channel:\n${inviteLink}\n\n` +
            `⚠️ This link is for you only — do not share it.\n` +
            `🌐 ganoflow.com`
          );
          console.log(`✅ Invite sent to ${telegramId} for ${planKey}`);
        }
      }
    }

    // ── 구독 취소/만료 → 자동 kick out ────────────────────────────────────
    if (event.type === 'customer.subscription.deleted' ||
        event.type === 'customer.subscription.paused') {

      const subscription = event.data.object;
      const customerId = subscription.customer;

      // Get customer metadata
      const customer = await stripe.customers.retrieve(customerId);
      const telegramId = customer.metadata?.telegramId;
      const planKey = customer.metadata?.planKey;
      const channelId = CHANNELS[planKey];

      if (telegramId && channelId) {
        // Get Telegram user ID from username
        const userId = await getUserIdByUsername(telegramId);

        if (userId) {
          await kickUser(channelId, userId);
          console.log(`🚫 Kicked ${telegramId} from ${planKey}`);

          await sendTelegramMessage(userId,
            `⚠️ *Your GanoFlow ${PLANS[planKey]?.name} subscription has ended.*\n\n` +
            `You have been removed from the channel.\n\n` +
            `To resubscribe, visit:\n🌐 ganoflow.com`
          );
        }
      }
    }

    // ── 결제 실패 → 경고 메시지 ───────────────────────────────────────────
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const customer = await stripe.customers.retrieve(customerId);
      const telegramId = customer.metadata?.telegramId;

      if (telegramId) {
        await sendTelegramMessage(telegramId,
          `⚠️ *GanoFlow — Payment Failed*\n\n` +
          `Your payment could not be processed. Please update your payment method to keep access.\n\n` +
          `🌐 ganoflow.com`
        );
      }
    }

  } catch (err) {
    console.error(`Webhook handler error: ${err.message}`);
  }

  res.json({ received: true });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'GanoFlow backend running' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 GanoFlow backend running on port ${PORT}`));
