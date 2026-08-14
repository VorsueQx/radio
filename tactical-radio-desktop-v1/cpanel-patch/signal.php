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
// Tactical Radio signaling endpoint - cPanel friendly.
// Shared room state is stored in a tiny JSON file. If the site folder is not
// writable, it automatically falls back to PHP's writable temp directory.

ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

function respond($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function choose_storage_file() {
    $localDir = __DIR__ . '/data';
    if (!is_dir($localDir)) @mkdir($localDir, 0775, true);

    if (is_dir($localDir) && is_writable($localDir)) {
        return $localDir . '/room.json';
    }

    $tmp = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR);
    if ($tmp && is_dir($tmp) && is_writable($tmp)) {
        // Unique per installation, so different sites/accounts do not collide.
        return $tmp . DIRECTORY_SEPARATOR . 'tactical_radio_' . substr(sha1(__DIR__), 0, 16) . '.json';
    }

    return null;
}

function load_state($fh) {
    rewind($fh);
    $raw = stream_get_contents($fh);
    $s = json_decode($raw ?: '{}', true);
    if (!is_array($s)) $s = [];
    if (!isset($s['peers']) || !is_array($s['peers'])) $s['peers'] = [];
    if (!isset($s['messages']) || !is_array($s['messages'])) $s['messages'] = [];
    if (!isset($s['chunks']) || !is_array($s['chunks'])) $s['chunks'] = [];
    return $s;
}

function save_state($fh, $s) {
    rewind($fh);
    if (!ftruncate($fh, 0)) return false;
    $json = json_encode($s, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) return false;
    if (fwrite($fh, $json) === false) return false;
    fflush($fh);
    return true;
}

function clean_state(&$s) {
    $cut = time() - 30;
    foreach ($s['peers'] as $id => $p) {
        if (($p['lastSeen'] ?? 0) < $cut) {
            unset($s['peers'][$id], $s['messages'][$id], $s['chunks'][$id]);
        }
    }
    foreach ($s['chunks'] as $to => &$msgs) {
        foreach ($msgs as $mid => $c) if (($c['ts'] ?? 0) < $cut) unset($msgs[$mid]);
        if (!$msgs) unset($s['chunks'][$to]);
    }
    unset($msgs);
}

// Easy browser test: /signal.php?health=1
if (isset($_GET['health'])) {
    $file = choose_storage_file();
    if (!$file) respond(['ok'=>false, 'error'=>'storage_not_writable'], 500);
    $fh = @fopen($file, 'c+');
    if (!$fh) respond(['ok'=>false, 'error'=>'storage_open_failed'], 500);
    @fclose($fh);
    respond(['ok'=>true, 'php'=>PHP_VERSION, 'storage'=>'ok']);
}

// V6: Öncelik GET. Bazı cPanel/ModSecurity kurulumları POST gövdesini tamamen
// boşalttığı için signaling verilerini query-string üzerinden kabul ediyoruz.
$input = !empty($_GET) ? $_GET : $_POST;

// Geriye dönük uyumluluk: POST gelirse ham gövdeyi de dene.
if (!is_array($input) || count($input) === 0) {
    $rawInput = file_get_contents('php://input');
    if (is_string($rawInput) && $rawInput !== '') {
        $parsed = [];
        parse_str($rawInput, $parsed);
        if (is_array($parsed) && count($parsed) > 0) $input = $parsed;
        if (!is_array($input) || count($input) === 0) {
            $decoded = json_decode($rawInput, true);
            if (is_array($decoded)) $input = $decoded;
        }
    }
}

if (!is_array($input) || count($input) === 0) {
    respond(['ok'=>false, 'error'=>'invalid_request', 'method'=>($_SERVER['REQUEST_METHOD'] ?? '')], 400);
}

// Form POST ile gelen karmaşık signaling payload JSON metnidir.
if (isset($input['payload']) && is_string($input['payload'])) {
    $decodedPayload = json_decode($input['payload'], true);
    if (is_array($decodedPayload)) $input['payload'] = $decodedPayload;
}

$action = $input['action'] ?? '';
$id = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($input['id'] ?? ''));
if (!$id || !$action) respond(['ok'=>false, 'error'=>'missing_fields'], 400);

$file = choose_storage_file();
if (!$file) respond(['ok'=>false, 'error'=>'storage_not_writable'], 500);

$fh = @fopen($file, 'c+');
if (!$fh) respond(['ok'=>false, 'error'=>'storage_open_failed'], 500);
if (!@flock($fh, LOCK_EX)) {
    @fclose($fh);
    respond(['ok'=>false, 'error'=>'storage_lock_failed'], 500);
}

$s = load_state($fh);
clean_state($s);
$now = time();
$out = ['ok'=>true];

if ($action === 'join') {
    if (count($s['peers']) >= 4 && !isset($s['peers'][$id])) {
        $out = ['ok'=>false, 'error'=>'full'];
    } else {
        $rawName = trim((string)($input['name'] ?? 'User'));
        if (function_exists('mb_substr')) $name = mb_substr($rawName, 0, 20);
        else $name = substr($rawName, 0, 20);
        if ($name === '') $name = 'User';

        $existing = [];
        foreach ($s['peers'] as $pid => $p) {
            if ($pid !== $id) $existing[] = ['id'=>$pid, 'name'=>$p['name'] ?? 'User', 'talking'=>!empty($p['talking'])];
        }
        $s['peers'][$id] = ['name'=>$name, 'lastSeen'=>$now, 'talking'=>false];
        if (!isset($s['messages'][$id])) $s['messages'][$id] = [];
        $out['peers'] = $existing;
    }
}
elseif ($action === 'poll') {
    if (!isset($s['peers'][$id])) {
        $out = ['ok'=>false, 'error'=>'not_joined'];
    } else {
        $s['peers'][$id]['lastSeen'] = $now;
        $out['messages'] = $s['messages'][$id] ?? [];
        $s['messages'][$id] = [];
        $out['peers'] = [];
        foreach ($s['peers'] as $pid => $p) {
            $out['peers'][] = ['id'=>$pid, 'name'=>$p['name'] ?? 'User', 'talking'=>!empty($p['talking'])];
        }
    }
}
elseif ($action === 'send_chunk') {
    if (isset($s['peers'][$id])) $s['peers'][$id]['lastSeen'] = $now;
    $to = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($input['to'] ?? ''));
    $msg = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($input['msg'] ?? ''));
    $index = intval($input['index'] ?? -1);
    $total = intval($input['total'] ?? 0);
    $data = (string)($input['data'] ?? '');
    if (!$to || !$msg || $index < 0 || $total < 1 || $total > 64 || $index >= $total || strlen($data) > 1200) {
        $out = ['ok'=>false, 'error'=>'bad_chunk'];
    } elseif (!isset($s['peers'][$to])) {
        $out = ['ok'=>false, 'error'=>'peer_missing'];
    } else {
        if (!isset($s['chunks'][$to])) $s['chunks'][$to] = [];
        if (!isset($s['chunks'][$to][$msg])) $s['chunks'][$to][$msg] = ['from'=>$id,'total'=>$total,'parts'=>[],'ts'=>$now];
        $s['chunks'][$to][$msg]['parts'][(string)$index] = $data;
        $parts = $s['chunks'][$to][$msg]['parts'];
        if (count($parts) >= $total) {
            $joined = '';
            for ($i=0; $i<$total; $i++) {
                $k=(string)$i;
                if (!isset($parts[$k])) { $joined=''; break; }
                $joined .= $parts[$k];
            }
            if ($joined !== '') {
                $b64 = strtr($joined, '-_', '+/');
                $pad = strlen($b64) % 4; if ($pad) $b64 .= str_repeat('=', 4-$pad);
                $json = base64_decode($b64, true);
                $payload = $json !== false ? json_decode($json, true) : null;
                if (is_array($payload)) {
                    if (!isset($s['messages'][$to])) $s['messages'][$to] = [];
                    $s['messages'][$to][] = ['from'=>$id, 'payload'=>$payload];
                }
            }
            unset($s['chunks'][$to][$msg]);
        }
    }
}
elseif ($action === 'send') {
    if (isset($s['peers'][$id])) $s['peers'][$id]['lastSeen'] = $now;
    $to = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($input['to'] ?? ''));
    $payload = $input['payload'] ?? null;
    if ($to && isset($s['peers'][$to]) && is_array($payload)) {
        if (!isset($s['messages'][$to])) $s['messages'][$to] = [];
        $s['messages'][$to][] = ['from'=>$id, 'payload'=>$payload];
        if (count($s['messages'][$to]) > 100) {
            $s['messages'][$to] = array_slice($s['messages'][$to], -100);
        }
    }
}
elseif ($action === 'talk') {
    if (!isset($s['peers'][$id])) {
        $out = ['ok'=>false, 'error'=>'not_joined'];
    } else {
        $s['peers'][$id]['lastSeen'] = $now;
        $s['peers'][$id]['talking'] = !empty($input['on']) && (string)$input['on'] !== '0';
    }
}
elseif ($action === 'leave') {
    unset($s['peers'][$id], $s['messages'][$id], $s['chunks'][$id]);
}
else {
    $out = ['ok'=>false, 'error'=>'unknown_action'];
}

if (!save_state($fh, $s)) {
    @flock($fh, LOCK_UN);
    @fclose($fh);
    respond(['ok'=>false, 'error'=>'storage_write_failed'], 500);
}

@flock($fh, LOCK_UN);
@fclose($fh);
respond($out);
