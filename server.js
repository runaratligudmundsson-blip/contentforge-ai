/**
 * ContentForge AI — Automated Backend Server
 */

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD
    }
});

// ===== MIDDLEWARE =====
app.use(cors());
// Webhook needs raw body — must come BEFORE express.json()
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static('public'));

const orders = [];

const PRICE_IDS = {
    starter:    process.env.STRIPE_PRICE_STARTER,
    growth:     process.env.STRIPE_PRICE_GROWTH,
    enterprise: process.env.STRIPE_PRICE_ENTERPRISE
};

// Pay-per-piece prices in cents (matching website: $9, $7, $12, $15)
function getOneTimePrice(type) {
    const prices = {
        blog:    900,
        social:  700,
        ads:    1200,
        email:  1500,
        product: 900,
        seo:    1500,
        mixed:  1200
    };
    return prices[type] || 900;
}

// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'ContentForge AI', timestamp: new Date().toISOString() });
});

// ===== SUBSCRIPTION CHECKOUT =====
app.post('/api/create-checkout', async (req, res) => {
    try {
        const { plan, email, name, company, content_type, tone, brief } = req.body;
        const metadata = {
            name: name || '', email: email || '', company: company || '',
            content_type: content_type || '', tone: tone || '', brief: brief || '',
            order_id: `CF-${Date.now()}`
        };

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            customer_email: email || undefined,
            metadata,
            line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
            success_url: `${process.env.DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.DOMAIN}/#pricing`
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Checkout error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// ===== PAY-PER-PIECE ORDER → Stripe one-time checkout =====
app.post('/api/order', async (req, res) => {
    try {
        const { name, email, company, website, plan, content_type, tone, brief } = req.body;
        const metadata = {
            name: name || '', email: email || '', company: company || '',
            website: website || '', content_type: content_type || '',
            tone: tone || '', brief: brief || '',
            order_id: `CF-${Date.now()}`
        };

        const contentLabels = {
            blog: 'Blog Post ($9)', social: 'Social Media Pack ($7)',
            ads: 'Ad Copy Bundle ($12)', email: 'Email Sequence ($15)',
            product: 'Product Descriptions ($9)', seo: 'SEO Strategy ($15)',
            mixed: 'Mixed Content ($12)'
        };

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            customer_email: email || undefined,
            metadata,
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `ContentForge AI — ${contentLabels[content_type] || content_type}`,
                        description: `AI-generated ${content_type} content for ${company || name}`
                    },
                    unit_amount: getOneTimePrice(content_type)
                },
                quantity: 1
            }],
            success_url: `${process.env.DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.DOMAIN}/#order`
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Order error:', error);
        res.status(500).json({ error: 'Failed to create order session' });
    }
});

// ===== STRIPE WEBHOOK =====
app.post('/api/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const meta = session.metadata || {};
        console.log(`✅ Payment received! Order: ${meta.order_id}`);

        const order = { id: meta.order_id, ...meta, paid: true, status: 'processing', created: new Date().toISOString() };
        orders.push(order);

        try {
            const content = await generateContent(order);
            order.content = content;
            order.status = 'delivered';
            if (order.email) await deliverContent(order);
            console.log(`📧 Content delivered to ${order.email}`);
        } catch (err) {
            console.error('Content generation error:', err);
            order.status = 'failed';
            try { await notifyAdmin(order, err); } catch (_) {}
        }
    }

    res.json({ received: true });
});

// ===== AI CONTENT GENERATION (gpt-4o-mini for cost) =====
async function generateContent(order) {
    const prompt = getContentPrompt(order);
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `You are an expert content writer for ContentForge AI. Write professional, engaging, SEO-optimized content. Tone: ${order.tone || 'professional and engaging'}. Never use filler — every sentence must add value.`
            },
            { role: 'user', content: prompt }
        ],
        max_tokens: 4000,
        temperature: 0.7
    });
    return response.choices[0].message.content;
}

function getContentPrompt(order) {
    const base = `Client: ${order.company || order.name}\nWebsite: ${order.website || 'N/A'}\nContent Type: ${order.content_type}\nBrand Voice: ${order.tone || 'Professional'}\nBrief: ${order.brief}`;

    const prompts = {
        blog:    `${base}\n\nWrite a comprehensive SEO-optimized blog post (1500-2000 words). Include: compelling headline, hook intro, H2/H3 structure, actionable takeaways, conclusion with CTA, 3 meta description options.`,
        social:  `${base}\n\nCreate a 7-day social media content package: 7 Instagram captions (with hashtags), 7 Twitter/X posts (≤280 chars), 3 LinkedIn posts, 3 Reel/TikTok script ideas.`,
        ads:     `${base}\n\nCreate an ad copy package: 5 Google Ads headlines (≤30 chars), 5 Google Ads descriptions (≤90 chars), 3 Facebook/Instagram ad copies, 3 landing page headline variants, 2 retargeting email subject lines.`,
        email:   `${base}\n\nWrite a 5-email nurture sequence: 1) Welcome, 2) Value/tips, 3) Brand story, 4) Offer, 5) Follow-up urgency. Include subject lines, preview text, and body copy for each.`,
        product: `${base}\n\nWrite 10 product descriptions (150-200 words each) with attention-grabbing headlines, benefit-focused copy, 3 bullet features, and SEO keywords.`,
        seo:     `${base}\n\nCreate an SEO content strategy: 20 target keywords with intent, 10 blog post ideas with outlines, content cluster map, publishing schedule, competitor gap suggestions, on-page checklist.`,
        mixed:   `${base}\n\nCreate a mixed content package: 1 blog post (1000 words), 5 social posts, 3 ad copy variants, 2 email templates — all cohesive and on-brand.`
    };
    return prompts[order.content_type] || prompts.mixed;
}

// ===== EMAIL DELIVERY =====
async function deliverContent(order) {
    await transporter.sendMail({
        from: `"ContentForge AI" <${process.env.EMAIL_USER}>`,
        to: order.email,
        subject: `✅ Your Content is Ready — Order ${order.id}`,
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,sans-serif;background:#0A0A0F;color:#F0F0F5;padding:40px 20px;">
<div style="max-width:600px;margin:0 auto;background:#12121A;border-radius:16px;border:1px solid #1F1F2E;padding:40px;">
  <div style="text-align:center;margin-bottom:32px;">
    <div style="display:inline-block;background:linear-gradient(135deg,#6C3AED,#06D6A0);padding:12px;border-radius:12px;font-size:24px;">⚡</div>
    <h1 style="margin:16px 0 0;font-size:24px;">Your Content is Ready!</h1>
  </div>
  <p style="color:#9CA3AF;">Hi ${order.name},</p>
  <p style="color:#9CA3AF;">Your <strong>${order.content_type}</strong> content has been generated. Here it is:</p>
  <div style="background:#0A0A0F;border:1px solid #1F1F2E;border-radius:12px;padding:24px;margin:24px 0;white-space:pre-wrap;line-height:1.7;color:#F0F0F5;font-size:14px;">${order.content}</div>
  <p style="color:#9CA3AF;">Need revisions? Reply to this email and we'll update within 24 hours.</p>
  <div style="margin-top:32px;padding-top:24px;border-top:1px solid #1F1F2E;text-align:center;color:#6B7280;font-size:12px;">
    <p>ContentForge AI — AI-Powered Content, Delivered Instantly</p>
  </div>
</div></body></html>`
    });
}

async function notifyAdmin(order, error) {
    await transporter.sendMail({
        from: `"ContentForge AI System" <${process.env.EMAIL_USER}>`,
        to: process.env.EMAIL_USER,
        subject: `⚠️ Order Failed — ${order.id}`,
        text: `Order ${order.id} failed.\n\nCustomer: ${order.name} (${order.email})\nType: ${order.content_type}\nError: ${error.message}\n\nHandle manually.`
    });
}

app.listen(PORT, () => {
    console.log(`⚡ ContentForge AI server running on port ${PORT}`);
});

module.exports = app;
