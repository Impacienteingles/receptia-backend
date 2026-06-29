const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const helperDir = '/Users/juanpablo/Desktop/APPS/Receptia/scratch/receptia-helper';

if (fs.existsSync(helperDir)) {
  fs.rmSync(helperDir, { recursive: true, force: true });
}
fs.mkdirSync(helperDir, { recursive: true });

const phpContent = `<?php
/*
Plugin Name: Receptia Helper Uploader
Description: Plugin helper temporal para restaurar la landing page estática limpia y eliminar plantillas PHP previas.
Version: 1.2
Author: Antigravity
*/

if (isset($_GET['action']) && $_GET['action'] === 'upload') {
    header('Content-Type: application/json');
    
    if (!isset($_GET['token']) || $_GET['token'] !== '1ImpacienteTokenReceptia') {
        echo json_encode(['success' => false, 'error' => 'Acceso no autorizado.']);
        exit;
    }

    if (!isset($_FILES['file'])) {
        echo json_encode(['success' => false, 'error' => 'No se ha subido ningún archivo.']);
        exit;
    }

    $uploadedFile = $_FILES['file']['tmp_name'];
    $destReceptia = $_SERVER['DOCUMENT_ROOT'] . '/receptia';
    $destThemeTemplate = $_SERVER['DOCUMENT_ROOT'] . '/wp-content/themes/applay/page-receptia.php';

    // 1. Eliminar plantilla PHP previa del tema si existe
    if (file_exists($destThemeTemplate)) {
        @unlink($destThemeTemplate);
    }

    // 2. Crear o limpiar carpeta destino receptia con forzado de permisos
    $deleteErrors = [];
    if (file_exists($destReceptia)) {
        $files = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($destReceptia, RecursiveDirectoryIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );

        foreach ($files as $fileinfo) {
            $realPath = $fileinfo->getRealPath();
            @chmod($realPath, 0777); // Forzar permisos de escritura
            if ($fileinfo->isDir()) {
                if (!@rmdir($realPath)) {
                    $deleteErrors[] = "No se pudo borrar directorio: $realPath";
                }
            } else {
                if (!@unlink($realPath)) {
                    $deleteErrors[] = "No se pudo borrar archivo: $realPath";
                }
            }
        }
        @chmod($destReceptia, 0777);
        @rmdir($destReceptia);
    }
    
    @mkdir($destReceptia, 0777, true);
    @chmod($destReceptia, 0777);

    // 3. Extraer zip completo en la carpeta receptia
    $zip = new ZipArchive;
    $extractionSuccess = false;
    $zipErrors = '';
    if ($zip->open($uploadedFile) === TRUE) {
        // Registrar archivos que se van a extraer
        $fileCount = $zip->numFiles;
        if ($zip->extractTo($destReceptia)) {
            $extractionSuccess = true;
            
            // 3.5. Copiar el APK al directorio raíz /descargas/ para resolver la URL https://corandar.com/descargas/receptia-v1.1.1.apk
            $apkSource = $destReceptia . '/descargas/receptia-v1.1.1.apk';
            $apkDestDir = $_SERVER['DOCUMENT_ROOT'] . '/descargas';
            $apkDestFile = $apkDestDir . '/receptia-v1.1.1.apk';
            
            if (file_exists($apkSource)) {
                if (!file_exists($apkDestDir)) {
                    @mkdir($apkDestDir, 0777, true);
                    @chmod($apkDestDir, 0777);
                }
                @copy($apkSource, $apkDestFile);
                @chmod($apkDestFile, 0644);
            }
            
            // 3.7. Limpiar la caché de WP Rocket y WordPress si están disponibles
            if (function_exists('rocket_clean_domain')) {
                @rocket_clean_domain();
            }
            if (function_exists('wp_cache_flush')) {
                @wp_cache_flush();
            }
        } else {
            $zipErrors = 'Falló la extracción física del zip.';
        }
        $zip->close();
    } else {
        $zipErrors = 'No se pudo abrir el archivo zip.';
    }

    // 4. Diagnosticar el estado del directorio tras la extracción
    $diagnoseFiles = [];
    if (file_exists($destReceptia)) {
        $dirIter = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($destReceptia, RecursiveDirectoryIterator::SKIP_DOTS)
        );
        foreach ($dirIter as $file) {
            $rel = str_replace($destReceptia, '', $file->getRealPath());
            $diagnoseFiles[] = [
                'file' => $rel,
                'size' => $file->getSize(),
                'writable' => is_writable($file->getRealPath()),
                'perms' => substr(sprintf('%o', $file->getPerms()), -4)
            ];
        }
    }

    echo json_encode([
        'success' => $extractionSuccess && empty($deleteErrors),
        'document_root' => $_SERVER['DOCUMENT_ROOT'],
        'dest_path' => $destReceptia,
        'delete_errors' => $deleteErrors,
        'zip_errors' => $zipErrors,
        'extracted_files_count' => isset($fileCount) ? $fileCount : 0,
        'diagnose_files' => $diagnoseFiles
    ]);
    exit;
}
`;

fs.writeFileSync(path.join(helperDir, 'receptia-helper.php'), phpContent, 'utf8');
console.log('Creado receptia-helper.php');

// Comprimir en receptia-helper.zip
const zipPath = '/Users/juanpablo/Desktop/APPS/Receptia/scratch/receptia-helper.zip';
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

try {
  execSync('zip -r "' + zipPath + '" .', { cwd: helperDir, stdio: 'inherit' });
  console.log(`🎉 Plugin helper comprimido con éxito en: ${zipPath}`);
} catch (err) {
  console.error('Error al comprimir plugin helper:', err.message);
}
