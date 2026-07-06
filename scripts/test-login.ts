import axios from 'axios';

async function test() {
  const tenants = [
    { email: 'soporte@receptia.ai', pin: '12345678', name: 'Receptia Atención al Cliente' },
    { email: 'duopeluqueros@receptia.ai', pin: '12345678', name: 'Peluquería Duo Peluqueros (pre-made)' },
    { email: 'laninadelospeines@receptia.ai', pin: '12345678', name: 'Peluquería La Niña de los Peines' },
    { email: 'caravaningplaza@receptia.ai', pin: '12345678', name: 'Caravaning Plaza' },
    { email: 'contacto@duopeluqueros.es', pin: '12345678', name: 'Duo Peluqueros (active)' },
    { email: 'info@peluqueriacarlosromero.com', pin: 'cortijo2018', name: 'Peluquería Carlos Romero' }
  ];

  console.log('Testing logins against receptia.corandar.com...');
  for (const t of tenants) {
    try {
      const res = await axios.post('https://receptia.corandar.com/api/auth/login', {
        email: t.email,
        pin: t.pin
      });
      console.log(`✅ Login Success: ${t.name} (${t.email}) -> Status ${res.status}`);
    } catch (err: any) {
      if (err.response) {
        console.error(`❌ Login Failed: ${t.name} (${t.email}) -> Status ${err.response.status}:`, err.response.data);
      } else {
        console.error(`❌ Connection Error for ${t.name}:`, err.message);
      }
    }
  }
}

test();
