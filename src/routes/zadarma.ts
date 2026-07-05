import { Router, Request, Response } from 'express';
import axios from 'axios';
import * as crypto from 'crypto';
import * as querystring from 'querystring';
import { getSettingVal } from '../services/supabase';

const router = Router();

function generateSignature(method: string, params: any, secret: string): string {
  const sortedKeys = Object.keys(params).sort();
  const sortedParams: any = {};
  sortedKeys.forEach(key => {
    sortedParams[key] = params[key];
  });

  const paramsStr = querystring.stringify(sortedParams);
  const md5Params = crypto.createHash('md5').update(paramsStr).digest('hex');
  const dataToSign = method + paramsStr + md5Params;

  const hexHash = crypto.createHmac('sha1', secret)
                        .update(dataToSign)
                        .digest('hex');

  return Buffer.from(hexHash).toString('base64');
}

async function callZadarma(
  method: string,
  apiUser: string,
  apiSecret: string,
  httpMethod: 'GET' | 'POST' | 'PUT',
  params: any = {}
): Promise<any> {
  const signature = generateSignature(method, params, apiSecret);
  const authHeader = `${apiUser}:${signature}`;
  const url = `https://api.zadarma.com${method}`;

  if (httpMethod === 'GET') {
    const response = await axios.get(url, {
      params,
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json'
      }
    });
    return response.data;
  } else if (httpMethod === 'PUT') {
    const response = await axios.put(url, querystring.stringify(params), {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });
    return response.data;
  } else {
    const response = await axios.post(url, querystring.stringify(params), {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });
    return response.data;
  }
}

// Helper to retrieve credentials
async function getCredentials(): Promise<{ user: string; secret: string } | null> {
  const user = await getSettingVal('ZADARMA_API_USER');
  const secret = await getSettingVal('ZADARMA_API_KEY');
  if (!user || !secret) {
    return null;
  }
  return { user, secret };
}

// 1. List Countries
router.get('/countries', async (req: Request, res: Response) => {
  try {
    const creds = await getCredentials();
    if (!creds) {
      return res.status(400).json({ error: 'Credenciales de Zadarma no configuradas en el sistema' });
    }
    const data = await callZadarma('/v1/direct_numbers/countries/', creds.user, creds.secret, 'GET', {});
    res.json(data);
  } catch (error: any) {
    console.error('Error listing countries in Zadarma:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al listar países en Zadarma', details: error.response?.data || error.message });
  }
});

// 2. List Cities/Prefices for a country
router.get('/country/:code', async (req: Request, res: Response) => {
  try {
    const creds = await getCredentials();
    if (!creds) {
      return res.status(400).json({ error: 'Credenciales de Zadarma no configuradas en el sistema' });
    }
    const countryCode = (req.params.code as string).toUpperCase();
    const data = await callZadarma('/v1/direct_numbers/country/', creds.user, creds.secret, 'GET', { country: countryCode });
    res.json(data);
  } catch (error: any) {
    console.error('Error listing cities in Zadarma:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al listar ciudades en Zadarma', details: error.response?.data || error.message });
  }
});

// 3. List Available numbers for a direction/city
router.get('/available/:directionId', async (req: Request, res: Response) => {
  try {
    const creds = await getCredentials();
    if (!creds) {
      return res.status(400).json({ error: 'Credenciales de Zadarma no configuradas en el sistema' });
    }
    const directionId = req.params.directionId;
    const data = await callZadarma(`/v1/direct_numbers/available/${directionId}/`, creds.user, creds.secret, 'GET', {});
    res.json(data);
  } catch (error: any) {
    console.error('Error listing available numbers in Zadarma:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al listar números disponibles en Zadarma', details: error.response?.data || error.message });
  }
});

// 4. List Purchased numbers
router.get('/purchased', async (req: Request, res: Response) => {
  try {
    const creds = await getCredentials();
    if (!creds) {
      return res.status(400).json({ error: 'Credenciales de Zadarma no configuradas en el sistema' });
    }
    const data = await callZadarma('/v1/direct_numbers/', creds.user, creds.secret, 'GET', {});
    res.json(data);
  } catch (error: any) {
    console.error('Error listing purchased numbers in Zadarma:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al listar números contratados en Zadarma', details: error.response?.data || error.message });
  }
});

// 5. Connect/Buy a direct virtual number
router.post('/numbers/buy', async (req: Request, res: Response) => {
  try {
    const creds = await getCredentials();
    if (!creds) {
      return res.status(400).json({ error: 'Credenciales de Zadarma no configuradas en el sistema' });
    }
    const { number_id } = req.body;
    if (!number_id) {
      return res.status(400).json({ error: 'El parámetro number_id es obligatorio' });
    }

    // Connect the direct number
    const data = await callZadarma('/v1/direct_numbers/', creds.user, creds.secret, 'POST', { number_id });
    res.json({
      status: 'success',
      message: 'Número contratado con éxito',
      details: data
    });
  } catch (error: any) {
    console.error('Error purchasing number in Zadarma:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al contratar el número virtual en Zadarma', details: error.response?.data || error.message });
  }
});

// Export helper for route updates
export { callZadarma, getCredentials };
export default router;
