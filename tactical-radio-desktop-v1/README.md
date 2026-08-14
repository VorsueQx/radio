# Tactical Radio Desktop V1

V12 web telsizinin Windows masaustu istemcisidir.

## Ne degisti?

- WebRTC + Metered TURN mantigi korunur.
- Arayuz uygulamanin icinde lokal calisir.
- cPanel'deki `signal.php` ve `turn.php` arka uç olarak kullanilir.
- PTT, Tauri global shortcut ile uygulama arka plandayken de calisir.
- Varsayilan PTT `V`.
- A-Z, 0-9 ve F1-F12 global PTT icin en sorunsuz seceneklerdir.

## 1. cPanel'e tek seferlik yama

`cpanel-patch/` klasorundeki `signal.php` ve `turn.php` dosyalarini mevcut:

`public_html/radio/`

klasorune yukle ve eskilerin ustune yaz.

**turn-config.php dosyasini DEGISTIRME / silme.** Metered bilgilerin onda kalmali.

## 2. EXE'yi bilgisayarinda hicbir sey kurmadan derleme

Bu proje GitHub Actions ile Windows'ta derlenebilir. Yerel bilgisayara npm, Rust veya Visual Studio kurman gerekmez.

1. GitHub'da bos bir repository olustur.
2. Bu ZIP'in icindeki dosyalari repository kokune yukle.
3. GitHub'da `Actions` sekmesine gir.
4. Soldan `Build Tactical Radio Windows` sec.
5. `Run workflow` butonuna bas.
6. Build bitince ayni sayfanin altindaki `Artifacts` bolumunden `Tactical-Radio-Windows` dosyasini indir.
7. Icindeki `.exe` Windows installer'dir.

## Kullanim

1. Tactical Radio'yu ac.
2. Mikrofon izni ver.
3. Kullanici adini yaz ve baglan.
4. Gerekirse `PTT TUSUNU DEGISTIR` ile tusu sec.
5. Uygulamayi minimize et.
6. Oyuna don. PTT tusuna basili tuttugunda telsiz calisir.

## Sunucu adresi

Masaustu istemcisi su backend'i kullanir:

`https://ahmetyyilmaz.com.tr/radio/`

Bunu degistirmek istersen `src/main.js` dosyasindaki `SERVER_BASE` degerini degistir.

## Not

Uygulamayi tamamen kapatmak telsizi kapatir. V1'de tray modu yoktur; minimize ederek kullan.
