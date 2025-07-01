require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 5000;

// — SMTP Setup —
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USERNAME,
    pass: process.env.EMAIL_PASSWORD,
  },
});
transporter.verify((err) => {
  if (err) console.error("❌ SMTP error:", err);
  else console.log("✅ SMTP server ready");
});

// — Middleware —
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") return next();
  express.json()(req, res, next);
});
app.use(cors());
app.post("/webhook", bodyParser.raw({ type: "application/json" }));

// — Price Map —
const PRICE_IDS = {
  500:  process.env.PRICE_ID_5,   // $5
  2500: process.env.PRICE_ID_25,  // $25
  5000: process.env.PRICE_ID_50,  // $50
  9200: process.env.PRICE_ID_92,  // $92
};

// — One-Time Donation —
app.post("/create-checkout-session", async (req, res) => {
  const { amount, email, name } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: email,
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `One-Time Donation — $${(amount / 100).toFixed(2)}`
          },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      success_url: `${process.env.CLIENT_URL}/donation-success`,
      cancel_url: `${process.env.CLIENT_URL}/donate`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ One-time donation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// — Monthly Subscription —
app.post("/create-subscription-session", async (req, res) => {
  const { amount, email, name } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    const priceId = PRICE_IDS[amount];
    if (!priceId) throw new Error("Invalid donation amount");

    const customer = await stripe.customers.create({ email, name });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.CLIENT_URL}/donation-success?subscribed=true&customerId=${customer.id}`,
      cancel_url: `${process.env.CLIENT_URL}/donate`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Subscription error:", err);
    res.status(500).json({ error: err.message });
  }
});

// — Customer Portal —
app.post("/create-customer-portal-session", async (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.status(400).json({ error: "Customer ID required" });

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.CLIENT_URL}/donation-success`,
    });
    res.json({ url: portalSession.url });
  } catch (err) {
    console.error("❌ Customer portal error:", err);
    res.status(500).json({ error: err.message });
  }
});

// — Stripe Webhook —
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("⚠️ Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    let email = session.customer_email;
    const amount = session.amount_total;
    const type = session.mode === "subscription" ? "Monthly" : "One-Time";
    const customerId = session.customer;

    // Fetch email from customer if not available
    if (!email && customerId) {
      try {
        const customer = await stripe.customers.retrieve(customerId);
        email = customer.email;
      } catch (error) {
        console.error("❌ Failed to retrieve customer email:", error);
      }
    }

    if (email) {
      sendDonationEmails(email, amount, type, customerId)
        .then(() => console.log("✅ Email sent"))
        .catch((err) => console.error("❌ Email error:", err));
    } else {
      console.error("❌ Email missing after customer lookup.");
    }
  }

  res.json({ received: true });
});

// — Email Helper —
async function sendDonationEmails(email, amount, type, customerId = null) {
  const usd = (amount / 100).toFixed(2);
  const isMonthly = type === "Monthly";
  let portalURL = "";

  if (isMonthly && customerId) {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.CLIENT_URL}/donation-success`,
    });
    portalURL = session.url;
  }

  const portalLink = isMonthly
    ? `<p>You can manage or cancel your subscription here: <a href="${portalURL}">Manage Subscription</a></p>`
    : "";

  // — Donor Email —
  await transporter.sendMail({
    from: `"Free Quran" <${process.env.EMAIL_USERNAME}>`,
    to: email,
    subject: `Your ${type} Donation to FreeQuran.store`,
    html: `
      <h2>Thank You!</h2>
      <p>We have received your <strong>${type}</strong> donation of <strong>$${usd}</strong>.</p>
      ${isMonthly ? "<p>This amount will be deducted monthly.</p>" : ""}
      ${portalLink}
      <p>May Allah reward you for your support!</p>
    `,
  });

  // — Admin Notification —
  await transporter.sendMail({
    from: `"Free Quran" <${process.env.EMAIL_USERNAME}>`,
    to: process.env.ADMIN_EMAIL,
    subject: `New ${type} Donation`,
    html: `<p>${type} donation of $${usd} by ${email}.</p>`,
  });
}

// — Start Server —
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
