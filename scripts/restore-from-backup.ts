import * as fs from 'fs';
import * as path from 'path';
import { supabase } from '../src/services/supabase';

async function run() {
  console.log('🤖 Starting restoration from backup file...');

  const backupPath = '/Users/juanpablo/Downloads/Copias de seguridad/Receptia_backup_2026-06-27_18-39-18.json';
  if (!fs.existsSync(backupPath)) {
    console.error(`Backup file not found at: ${backupPath}`);
    return;
  }

  try {
    const rawData = fs.readFileSync(backupPath, 'utf8');
    const backup = JSON.parse(rawData);

    const { tenants, appointments } = backup;

    if (!tenants || !Array.isArray(tenants)) {
      console.error('No tenants array found in backup file.');
      return;
    }

    console.log(`Found ${tenants.length} tenants in backup.`);
    console.log(`Found ${appointments?.length || 0} appointments in backup.`);

    // 1. Restore tenants
    console.log('Upserting tenants to Supabase...');
    const { error: tErr } = await supabase.from('tenants').upsert(tenants);
    if (tErr) {
      console.error('Error restoring tenants:', tErr.message);
      return;
    }
    console.log('✅ Tenants restored successfully.');

    // Update Peluquería Carlos Romero to active status to prevent trial expiry cron from suspending it
    console.log('Activating Peluquería Carlos Romero subscription...');
    const { error: actErr } = await supabase
      .from('tenants')
      .update({ subscription_status: 'active', is_trial: false })
      .eq('id', '62d1ed82-287c-4329-941b-50b578c15b14');

    if (actErr) {
      console.error('Error activating Carlos Romero:', actErr.message);
    } else {
      console.log('✅ Carlos Romero set to ACTIVE successfully.');
    }

    // 2. Restore appointments
    if (appointments && Array.isArray(appointments) && appointments.length > 0) {
      console.log('Upserting appointments to Supabase...');
      const { error: aErr } = await supabase.from('appointments').upsert(appointments);
      if (aErr) {
        console.error('Error restoring appointments:', aErr.message);
        return;
      }
      console.log('✅ Appointments restored successfully.');
    }

    // 3. Assign virtual phone numbers back to the restored tenants
    console.log('Re-linking virtual phone numbers...');
    // - Peluquería Carlos Romero (62d1ed82-287c-4329-941b-50b578c15b14) -> +34858215153
    const { error: errPhone1 } = await supabase
      .from('virtual_phones')
      .update({ tenant_id: '62d1ed82-287c-4329-941b-50b578c15b14', status: 'assigned' })
      .eq('phone_number', '+34858215153');

    if (errPhone1) {
      console.error('Error updating phone +34858215153:', errPhone1.message);
    } else {
      console.log('✅ Re-linked +34858215153 to Peluquería Carlos Romero.');
    }

    // - Receptia Atención al Cliente (77777777-7777-7777-7777-777777777777) -> +34858215345
    const { error: errPhone2 } = await supabase
      .from('virtual_phones')
      .update({ tenant_id: '77777777-7777-7777-7777-777777777777', status: 'assigned' })
      .eq('phone_number', '+34858215345');

    if (errPhone2) {
      console.error('Error updating phone +34858215345:', errPhone2.message);
    } else {
      console.log('✅ Re-linked +34858215345 to Receptia Atención al Cliente.');
    }

    // - Receptia Departamento de Demostraciones (d1180213-8036-4acd-a6de-3e3287ba73dc) -> +34858215318
    const { error: errPhone3 } = await supabase
      .from('virtual_phones')
      .update({ tenant_id: 'd1180213-8036-4acd-a6de-3e3287ba73dc', status: 'assigned' })
      .eq('phone_number', '+34858215318');

    if (errPhone3) {
      console.error('Error updating phone +34858215318:', errPhone3.message);
    } else {
      console.log('✅ Re-linked +34858215318 to Receptia Departamento de Demostraciones.');
    }

    console.log('🎉 Restoration completed successfully.');
  } catch (err: any) {
    console.error('An unexpected error occurred during restoration:', err.message);
  }
}

run();
