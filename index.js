require('dotenv').config();
const venom = require('venom-bot');
const axios = require('axios');
const crypto = require('crypto');

// Configuration
const config = {
  apiKey: process.env.API_KEY,
  baseUrl: 'https://greatfollows.com/adminapi/v2',
  sessionName: process.env.SESSION_NAME || 'greatfollows-bot'
};

// Data stores
const verificationCodes = new Map(); // phone -> {code, username, timestamp}
const verifiedUsers = new Map();     // phone -> username
const pendingTickets = new Map();    // username -> ticketId

// 🚀 Initialize Bot
venom.create({
  session: config.sessionName,
  multidevice: true,
  headless: true,
  useChrome: true,
  browserArgs: ['--no-sandbox'],
  disableSpins: true,
  disableWelcome: true,
  logQR: true
})
.then((client) => {
  console.log('🤖 GreatFollows WhatsApp Bot started!');
  startBot(client);
})
.catch((error) => {
  console.error('🔥 Bot startup error:', error);
  process.exit(1);
});

// 🎯 Bot Logic
function startBot(client) {
  client.onMessage(async (message) => {
    try {
      if (!message.isGroupMsg) {
        await handleMessage(client, message);
      }
    } catch (error) {
      console.error('Message handling error:', error);
      await client.sendText(message.from, '⚠️ An error occurred. Please try again.');
    }
  });
}

// 📩 Message Handler
async function handleMessage(client, message) {
  const phone = message.from;
  const msg = (message.body || '').toString().trim();

  // 1. Check if user is already verified
  if (verifiedUsers.has(phone)) {
    return handleVerifiedUser(client, phone, msg);
  }

  // 2. Check if this is a verification code submission
  if (verificationCodes.has(phone) && msg.length === 6 && /^\d+$/.test(msg)) {
    return handleVerificationCode(client, phone, msg);
  }

  // 3. Otherwise treat as username submission
  if (msg.length > 0) {
    return handleUsernameSubmission(client, phone, msg);
  }
}

// 🔑 Handle username submission
async function handleUsernameSubmission(client, phone, username) {
  try {
    // Check if username exists in system
    const response = await axios.get(`${config.baseUrl}/users`, {
      headers: { 
        'Content-Type': 'application/json',
        'X-Api-Key': config.apiKey
      }
    });

    const user = response.data.data.list.find(
      u => u.username === username || u.email === username
    );

    if (!user) {
      return client.sendText(phone, 
        '❌ Username/email not found in our system.\n' +
        'Please enter your correct GreatFollows username or email.'
      );
    }

    // Create verification ticket
    const ticketResponse = await axios.post(`${config.baseUrl}/tickets/add`, {
      username: user.username,
      subject: 'WhatsApp Verification Request',
      message: `User ${user.username} requesting WhatsApp verification`
    }, {
      headers: { 
        'Content-Type': 'application/json',
        'X-Api-Key': config.apiKey
      }
    });

    if (ticketResponse.data.error_code !== 0) {
      throw new Error(ticketResponse.data.error_message);
    }

    const ticketId = ticketResponse.data.data.ticket_id;
    pendingTickets.set(user.username, ticketId);

    // Generate and store verification code (valid for 10 minutes)
    const verificationCode = crypto.randomInt(100000, 999999).toString();
    verificationCodes.set(phone, {
      code: verificationCode,
      username: user.username,
      timestamp: Date.now()
    });

    // Send code to user (in production, send via email instead)
    return client.sendText(phone,
      `🔐 Verification code for ${user.username}:\n\n` +
      `📌 ${verificationCode}\n\n` +
      `This code will expire in 10 minutes.\n` +
      `Reply with this code to verify your account.`
    );

  } catch (error) {
    console.error('Username handling error:', error);
    return client.sendText(phone,
      '⚠️ Could not initiate verification.\n' +
      'Please try again later or contact support.'
    );
  }
}

// ✅ Handle verification code submission
async function handleVerificationCode(client, phone, code) {
  try {
    const storedData = verificationCodes.get(phone);
    
    // Check if code exists
    if (!storedData) {
      return client.sendText(phone,
        '❌ No active verification request found.\n' +
        'Please start over by sending your username.'
      );
    }

    // Check if code expired (10 minutes)
    if (Date.now() - storedData.timestamp > 600000) {
      verificationCodes.delete(phone);
      return client.sendText(phone,
        '❌ Verification code expired.\n' +
        'Please start over by sending your username.'
      );
    }

    // Verify code
    if (code !== storedData.code) {
      return client.sendText(phone, '❌ Invalid verification code. Please try again.');
    }

    // Mark user as verified
    verifiedUsers.set(phone, storedData.username);
    verificationCodes.delete(phone);

    // Update ticket status
    const ticketId = pendingTickets.get(storedData.username);
    if (ticketId) {
      await axios.post(`${config.baseUrl}/tickets/update`, {
        ticket_id: ticketId,
        status: 'resolved',
        message: 'User successfully verified via WhatsApp'
      }, {
        headers: { 
          'Content-Type': 'application/json',
          'X-Api-Key': config.apiKey
        }
      });
      pendingTickets.delete(storedData.username);
    }

    return client.sendText(phone,
      `✅ Verification successful! Welcome ${storedData.username}!\n\n` +
      `You can now:\n` +
      `- Check your orders with /order [id]\n` +
      `- Get help with /help`
    );

  } catch (error) {
    console.error('Verification error:', error);
    return client.sendText(phone,
      '⚠️ Could not complete verification.\n' +
      'Please try again later or contact support.'
    );
  }
}

// 💼 Handle verified user commands
async function handleVerifiedUser(client, phone, msg) {
  const username = verifiedUsers.get(phone);

  // Help command
  if (msg.toLowerCase() === '/help') {
    return client.sendText(phone,
      `📖 ${username}'s Account Help:\n\n` +
      `/order [id] - Check order status\n` +
      `/help - Show this message\n\n` +
      `Need support? Contact our team.`
    );
  }

  // Order status command
  if (msg.toLowerCase().startsWith('/order ')) {
    const orderId = msg.split(' ')[1];
    if (!orderId) {
      return client.sendText(phone,
        '❌ Please provide an order ID.\n' +
        'Example: /order 12345'
      );
    }

    try {
      const response = await axios.get(`${config.baseUrl}/orders/${orderId}`, {
        headers: { 
          'Content-Type': 'application/json',
          'X-Api-Key': config.apiKey
        }
      });

      if (response.data.error_code !== 0) {
        throw new Error(response.data.error_message);
      }

      const order = response.data.data;
      const statusMessage = 
        `📦 Order #${order.id}\n` +
        `🛍️ Service: ${order.service_name}\n` +
        `🔄 Status: ${order.status}\n` +
        `📊 Quantity: ${order.quantity}\n` +
        `⏳ Remaining: ${order.remains}\n` +
        `📅 Created: ${order.created}\n` +
        `🔗 Link: ${order.link || 'N/A'}`;

      return client.sendText(phone, statusMessage);

    } catch (error) {
      console.error('Order check error:', error);
      return client.sendText(phone,
        '❌ Could not fetch order details.\n' +
        'Please check the order ID and try again.'
      );
    }
  }

  // Default response for verified users
  return client.sendText(phone,
    `ℹ️ Hello ${username}!\n\n` +
    `Send /order [id] to check order status\n` +
    `Or /help for more options`
  );
}