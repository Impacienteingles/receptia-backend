import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

async function buildExe() {
  console.log('🏁 Iniciando compilación de Receptia a ejecutable de Windows (.exe)...');

  // 1. Compilar TypeScript a Javascript en dist/
  console.log('⚙️ Compilando código TypeScript...');
  execSync('npm run build', { stdio: 'inherit' });
  console.log('✅ Compilación de TypeScript completada.');

  // 2. Empaquetar el servidor compilado dist/index.js usando pkg
  console.log('📦 Empaquetando aplicación con pkg (npx pkg)...');
  try {
    // npx pkg dist/index.js --targets node18-win-x64 --output dist/receptia.exe
    execSync('npx pkg dist/index.js --targets node18-win-x64 --output dist/receptia.exe', { stdio: 'inherit' });
    
    console.log('\n🎉 ==================================================== 🎉');
    console.log('  ¡EL EJECUTABLE SE GENERÓ CON ÉXITO EN dist/receptia.exe!');
    console.log('========================================================');
    console.log('  Para usarlo de forma portable en cualquier PC:');
    console.log('  1. Crea una carpeta vacía (ej. "Receptia_Desktop").');
    console.log('  2. Copia dist/receptia.exe a esa carpeta.');
    console.log('  3. Copia también la carpeta "public" y el archivo ".env" al lado del exe.');
    console.log('  4. Haz doble clic en receptia.exe y se iniciará en el puerto 3000.');
    console.log('========================================================\n');
  } catch (error: any) {
    console.error('❌ Error al empaquetar con pkg:', error.message);
    process.exit(1);
  }
}

buildExe();
