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

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const orders = [];

const PRICE_IDS = {
    starter: process.env.STRIPE_PRICE_STARTER,
    growth: process.env.STRIPE_PRICE_GROWTH,
    enterprise: process.env.STRIPE_PRICE_ENTERPRISE
};

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'ContentForge AI', timestamp: new Date().toISOString() });
});

app.post('/api/create-checkout', async (req, res) => {
    try {
        const { plan, email, name, company, content_type, tone, brief } = req.body;
        const metadata = { name, email, company: company || '', content_type, tone: tone || '', brief: brief || '', order_id: 'CF-' + Date.now() };

        if (plan === 'one-time') {
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'], mode: 'payment', customer_email: email, metadata,
                line_items: [{ price_data: { currency: 'usd', product_data: { name: 'ContentForge AI — ' + content_type + ' (One-Time)', description: 'Custom AI-generated content' }, unit_amount: getOneTimePrice(content_type) }, quantity: 1 }],
                success_url: process.env.DOMAIN + '/success?session_id={CHECKOUT_SESSION_ID}',
                cancel_url: process.env.DOMAIN + '/#pricing'
            });
            return res.json({ url: session.url });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'], mode: 'subscription', customer_email: email, metadata,
            line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
            success_url: process.env.DOMAIN + '/success?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: process.env.DOMAIN + '/#pricing'
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error('Checkout error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send('Webhook Error: ' + err.message);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const meta = session.metadata;
        const order = { id: meta.order_id, ...meta, paid: true, status: 'processing', created: new Date().toISOString() };
        orders.push(order);
        try {
            order.content = await generateContent(order);
            order.status = 'delivered';
            await deliverContent(order);
            console.log('Content delivered to ' + order.email);
        } catch (err) {
            console.error('Generation error:', err);
            order.status = 'failed';
        }
    }
    res.json({ received: true });
});

async function generateContent(order) {
    const prompts = { blog: 'Write a 1500-word SEO blog post about: ' + order.brief, social: 'Create a 7-day social media content pack for: ' + order.brief, ads: 'Write ad copy bundle for: ' + order.brief, email: 'Write a 5-email nurture sequence for: ' + order.brief, product: 'Write 10 product descriptions for: ' + order.brief, seo: 'Create SEO content strategy for: ' + order.brief, mixed: 'Create mixed content pack for: ' + order.brief };
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: 'You are an expert content writer. Write professional, engaging, SEO-optimized content. Tone: ' + (order.tone || 'professional') }, { role: 'user', content: prompts[order.content_type] || prompts.mixed }],
        max_tokens: 3000, temperature: 0.7
    });
    return response.choices[0].message.content;
}

async function deliverContent(order) {
    await transporter.sendMail({
        from: '"ContentForge AI" <' + process.env.EMAIL_USER + '>',
        to: order.email,
        subject: 'Your Content is Ready — Order ' + order.id,
        html: '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:40px"><h1>Your content is ready, ' + order.name + '!</h1><pre style="background:#f5f5f5;padding:20px;border-radius:8px;white-space:pre-wrap">' + order.content + '</pre><p>Need revisions? Reply to this email.</p><p>ContentForge AI</p></div>'
    });
}

function getOneTimePrice(type) {
    const prices = { blog: 900, social: 700, ads: 1200, email: 1500, product: 900, seo: 9900, mixed: 4900 };
    return prices[type] || 900;
}

app.listen(PORT, () => console.log('ContentForge AI running on port ' + PORT));
module.exports = app;
