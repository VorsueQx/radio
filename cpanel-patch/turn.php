<?php
// Desktop istemcisi icin CORS. Mevcut web sitesi ayni sekilde calismaya devam eder.
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$allowedOrigins = [
    'http://tauri.localhost',
    'https://tauri.localhost',
    'tauri://localhost',
    'http://localhost:1420',
    'https://ahmetyyilmaz.com.tr'
];
if ($origin !== '' && in_array($origin, $allowedOrigins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Accept');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
ini_set('display_errors','0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$configFile = __DIR__ . '/turn-config.php';
if (!is_file($configFile)) {
    http_response_code(500);
    echo json_encode(['ok'=>false,'error'=>'turn_config_missing']);
    exit;
}

$config = require $configFile;
$username = trim((string)($config['username'] ?? ''));
$password = trim((string)($config['password'] ?? ''));

if ($username === '' || $password === '' || $username === 'BURAYA_USERNAME' || $password === 'BURAYA_PASSWORD') {
    http_response_code(500);
    echo json_encode(['ok'=>false,'error'=>'turn_not_configured']);
    exit;
}

$iceServers = [
    ['urls' => 'stun:stun.relay.metered.ca:80'],
    ['urls' => 'turn:global.relay.metered.ca:80', 'username'=>$username, 'credential'=>$password],
    ['urls' => 'turn:global.relay.metered.ca:80?transport=tcp', 'username'=>$username, 'credential'=>$password],
    ['urls' => 'turn:global.relay.metered.ca:443', 'username'=>$username, 'credential'=>$password],
    ['urls' => 'turns:global.relay.metered.ca:443?transport=tcp', 'username'=>$username, 'credential'=>$password],
];

echo json_encode(['ok'=>true,'iceServers'=>$iceServers], JSON_UNESCAPED_SLASHES);
