import { supabase } from '../src/services/supabase';

async function testConnection() {
  console.log('Testing Supabase connection...');
  try {
    const { data, error } = await supabase
      .from('tenants')
      .select('*')
      .limit(1);

    if (error) {
      if (error.code === '42P01') {
        console.log('\n❌ ERROR: La tabla "tenants" no existe en la base de datos de Supabase.');
        console.log('Por favor, ve al panel de control de Supabase (https://supabase.com), abre el SQL Editor de tu proyecto "Receptia"');
        console.log('y ejecuta el archivo "supabase_schema.sql" que acabamos de crear.');
      } else {
        console.log('❌ Error de Supabase:', error.message);
      }
      process.exit(1);
    }

    console.log('\n✅ ¡Conexión a Supabase exitosa y la tabla "tenants" existe!');
    console.log('Número de inquilinos actuales:', data.length);
  } catch (err: any) {
    console.log('❌ Error inesperado al conectar a Supabase:', err.message);
    process.exit(1);
  }
}

testConnection();
