const { sendOutreachEmail } = require('./src/services/outreach');
require('dotenv').config();

async function main() {
  console.log('Testing sendOutreachEmail...');
  try {
    const success = await sendOutreachEmail({
      businessName: 'Test Business',
      toEmail: 'yoyrenfe@gmail.com',
      demoUrl: 'https://corandar.onrender.com/customer-demo-url',
      audioUrl: 'https://dxc03zgurdly9.cloudfront.net/e217a543bf3d586a76a66e88a4d56aff5c502d9c2ee29fcce7dadb973fc6add1/recording.wav',
      sector: 'general',
      subject: 'Test Email from Receptia CLI',
      bodyOverride: 'Esto es una prueba de envío.'
    });
    console.log('Result:', success);
  } catch (err) {
    console.error('Caught error during email send:', err.message);
  }
}

main();
