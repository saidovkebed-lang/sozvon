// sozvon-capture.exe — захват экрана/окна для демонстрации в «Созвоне» (Windows).
//
// Зачем: Chromium (Electron 44) на Windows 11 24H2+ захватывает экран и окна только через
// Windows Graphics Capture с включённым захватом курсора — а это заставляет Windows перевести
// курсор в программный режим, и в играх со своим курсором (Noita и др.) он пропадает.
// Здесь — DXGI Desktop Duplication (как «Захват экрана» в OBS): системный курсор не трогается,
// курсор дорисовываем в кадр сами (GetCursorInfo + DrawIconEx). Запасной путь — GDI BitBlt
// без CAPTUREBLT (тоже не трогает курсор).
//
// Запуск:   sozvon-capture.exe (--monitor X,Y,W,H | --hwnd N) [--max-width W] [--max-height H] [--fps F] [--no-cursor]
//                              [--listen --token T --origin O]
//           координаты монитора — физические пиксели виртуального экрана.
// Кадры:    подряд: заголовок 24 байта (u32 'SZC1', u32 width, u32 height, u32 length,
//           u64 timestamp µs), затем I420 (BT.709, ограниченный диапазон) длиной length.
//           Без --listen — в stdout. С --listen — по HTTP с 127.0.0.1 (страница читает fetch'ем, минуя
//           главный процесс Electron): в stdout печатается "PORT n", кадры отдаются на GET /T одному
//           клиенту (CORS — только для O); пока никто не подключился 20 с — выход с кодом 4.
// Звук:     sozvon-capture.exe --audio-exclude-pid PID --listen --token T --origin O
//           системный звук БЕЗ звука процесса PID и всех его потомков (WASAPI process loopback, Windows 11 /
//           Windows 10 build 20348+): так в трансляцию не попадают голоса звонка, которые играет само приложение.
//           Пакеты: заголовок 24 байта (u32 'SZA1', u32 sampleRate, u32 channels, u32 length, u64 timestamp µs),
//           затем PCM s16 interleaved. Пока ничего не звучит — тишина в реальном темпе (дорожка не «засыпает»).
//           Код выхода 4 — process loopback недоступен (старая Windows / нет устройства вывода).
// Клавиши:  sozvon-capture.exe --keys [--watch VK,VK…]  — рация без перехватчиков ввода: Raw Input (RIDEV_INPUTSINK)
//           только СЛУШАЕТ клавиатуру (как Discord) — в отличие от WH_KEYBOARD_LL/WH_MOUSE_LL ввод игр через нас
//           не проходит и не задерживается (античиты соревновательных игр к хукам ввода относятся враждебно).
//           stdout: строки "d VK" / "u VK" (десятичный виртуальный код) только для отслеживаемых клавиш;
//           Enter цифрового блока — 256+VK_RETURN; цифры блока при выключенном NumLock приводятся к VK_NUMPAD*.
//           stdin: "watch VK,VK…" — сменить список.
// Медиа:    sozvon-capture.exe --media — что играет на ПК (системные медиасессии Windows 10/11, C++/WinRT
//           GlobalSystemMediaTransportControlsSessionManager): "READY", затем строка JSON на каждое изменение
//           (и не реже раза в 5 с, пока что-то играет): {"t":"media","sessions":[{"app":AUMID,"title","artist",
//           "album","albumArtist","durationMs","positionMs","updatedAt" (unix мс: позиция — на этот момент; 0 — нет),
//           "playing","current"}]}. Код выхода 4 — медиасессии недоступны.
// stdin:    строки "pause" / "resume"; конец stdin — выход.
// stderr:   журнал. Коды выхода: 0 — штатно, 2 — аргументы, 3 — окно закрыто, 4 — захват недоступен.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dwmapi.h>
#include <mmsystem.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdarg>
#include <string>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <algorithm>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <chrono>
#ifdef _MSC_VER
// C++/WinRT (заголовки из Windows SDK) — только для режима --media
#undef GetCurrentTime
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Media.Control.h>
#endif

#ifdef _MSC_VER
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "winmm.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "windowsapp.lib")
#endif

// ---------------------------------------------------------------- утилиты
template <class T> struct Com {
  T* p = nullptr;
  Com() = default;
  Com(const Com&) = delete;
  Com& operator=(const Com&) = delete;
  ~Com() { reset(); }
  void reset() { if (p) { p->Release(); p = nullptr; } }
  T** put() { reset(); return &p; }
  T* operator->() const { return p; }
  explicit operator bool() const { return p != nullptr; }
};

static void logf(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fputs("[capture] ", stderr);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  fflush(stderr);
  va_end(ap);
}

static volatile LONG g_quit = 0;
static volatile LONG g_paused = 0;
static volatile LONG g_watch[512] = {};  // режим --keys: какие виртуальные коды сообщать

static void setWatch(const std::string& list) {
  for (int i = 0; i < 512; i++) InterlockedExchange(&g_watch[i], 0);
  const char* p = list.c_str();
  while (*p) {
    char* end = nullptr;
    long v = strtol(p, &end, 0);
    if (end == p) { p++; continue; }
    if (v > 0 && v < 512) InterlockedExchange(&g_watch[v], 1);
    p = end;
  }
}

static DWORD WINAPI stdinThread(LPVOID) {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  char buf[256];
  std::vector<char> line;
  for (;;) {
    DWORD n = 0;
    if (!ReadFile(in, buf, sizeof buf, &n, nullptr) || n == 0) break;
    for (DWORD i = 0; i < n; i++) {
      if (buf[i] == '\n' || buf[i] == '\r') {
        std::string s(line.begin(), line.end());
        line.clear();
        if (s == "pause") InterlockedExchange(&g_paused, 1);
        else if (s == "resume") InterlockedExchange(&g_paused, 0);
        else if (s == "quit") { InterlockedExchange(&g_quit, 1); return 0; }
        else if (s.rfind("watch", 0) == 0) setWatch(s.substr(5));
      } else if (line.size() < 2048) {
        line.push_back(buf[i]);
      }
    }
  }
  InterlockedExchange(&g_quit, 1);
  return 0;
}

static bool writeAll(HANDLE h, const void* data, size_t len) {
  const uint8_t* p = static_cast<const uint8_t*>(data);
  while (len) {
    DWORD chunk = (DWORD)std::min<size_t>(len, 1 << 24), n = 0;
    if (!WriteFile(h, p, chunk, &n, nullptr) || n == 0) return false;
    p += n;
    len -= n;
  }
  return true;
}

static uint64_t nowUs();

// Куда пишем кадры: stdout или сокет клиента
struct Sink {
  HANDLE h = nullptr;
  SOCKET s = INVALID_SOCKET;
  bool write(const void* data, size_t len) {
    if (s == INVALID_SOCKET) return writeAll(h, data, len);
    const char* p = static_cast<const char*>(data);
    while (len) {
      int n = send(s, p, (int)std::min<size_t>(len, 1 << 20), 0);
      if (n <= 0) return false;
      p += n;
      len -= n;
    }
    return true;
  }
};

static bool sendStr(SOCKET c, const std::string& s) {
  return send(c, s.data(), (int)s.size(), 0) == (int)s.size();
}

// Локальный HTTP: ждём GET /token (OPTIONS — предварительный запрос CORS/доступа к локальной сети)
static SOCKET acceptClient(const std::string& token, const std::string& origin) {
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa)) return INVALID_SOCKET;
  SOCKET ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (ls == INVALID_SOCKET) return INVALID_SOCKET;
  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = 0;
  int alen = sizeof addr;
  if (bind(ls, (sockaddr*)&addr, sizeof addr) || listen(ls, 4) || getsockname(ls, (sockaddr*)&addr, &alen)) { closesocket(ls); return INVALID_SOCKET; }
  printf("PORT %d\n", ntohs(addr.sin_port));
  fflush(stdout);
  const std::string cors = "Access-Control-Allow-Origin: " + origin + "\r\nAccess-Control-Allow-Private-Network: true\r\n"
                           "Access-Control-Allow-Local-Network: true\r\nVary: Origin\r\n";
  uint64_t deadline = nowUs() + 20000000ull;
  while (!g_quit) {
    if (nowUs() > deadline) { logf("никто не подключился"); break; }
    fd_set fs;
    FD_ZERO(&fs);
    FD_SET(ls, &fs);
    timeval tv = { 0, 200000 };
    if (select(0, &fs, nullptr, nullptr, &tv) <= 0) continue;
    SOCKET c = accept(ls, nullptr, nullptr);
    if (c == INVALID_SOCKET) continue;
    DWORD to = 5000;
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, (const char*)&to, sizeof to);
    std::string req;
    char buf[2048];
    while (req.size() < 16384 && req.find("\r\n\r\n") == std::string::npos) {
      int n = recv(c, buf, sizeof buf, 0);
      if (n <= 0) break;
      req.append(buf, n);
    }
    size_t sp1 = req.find(' '), sp2 = sp1 == std::string::npos ? sp1 : req.find(' ', sp1 + 1);
    std::string method = sp1 == std::string::npos ? "" : req.substr(0, sp1);
    std::string path = sp2 == std::string::npos ? "" : req.substr(sp1 + 1, sp2 - sp1 - 1);
    if (method == "OPTIONS") {
      sendStr(c, "HTTP/1.1 204 No Content\r\n" + cors + "Access-Control-Allow-Methods: GET\r\nAccess-Control-Allow-Headers: *\r\n"
                 "Access-Control-Max-Age: 600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      closesocket(c);
      continue;
    }
    if (method == "GET" && path == "/" + token) {
      sendStr(c, "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nCache-Control: no-store\r\n" + cors + "Connection: close\r\n\r\n");
      int sb = 8 << 20;
      setsockopt(c, SOL_SOCKET, SO_SNDBUF, (const char*)&sb, sizeof sb);
      closesocket(ls);
      logf("клиент подключён");
      return c;
    }
    sendStr(c, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    closesocket(c);
  }
  closesocket(ls);
  return INVALID_SOCKET;
}

static uint64_t nowUs() {
  static LARGE_INTEGER f = [] { LARGE_INTEGER x; QueryPerformanceFrequency(&x); return x; }();
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  return (uint64_t)((double)c.QuadPart * 1e6 / (double)f.QuadPart);
}

// ---------------------------------------------------------------- BGRA → I420 (BT.709, limited) с масштабированием
static inline uint8_t clamp8(int v) { return (uint8_t)(v < 0 ? 0 : v > 255 ? 255 : v); }
static inline uint8_t toY(int r, int g, int b) { return clamp8(16 + ((47 * r + 157 * g + 16 * b + 128) >> 8)); }
static inline uint8_t toU(int r, int g, int b) { return clamp8(128 + ((-26 * r - 87 * g + 112 * b + 128) >> 8)); }
static inline uint8_t toV(int r, int g, int b) { return clamp8(128 + ((112 * r - 102 * g - 10 * b + 128) >> 8)); }

struct Scaler {
  int sw = 0, sh = 0, dw = 0, dh = 0;
  std::vector<int> x0, xf, y0, yf;  // индекс и доля (0..255) по осям
  std::vector<int> rgb;             // 2 строки × dw × 3

  void setup(int sw_, int sh_, int dw_, int dh_) {
    if (sw == sw_ && sh == sh_ && dw == dw_ && dh == dh_) return;
    sw = sw_; sh = sh_; dw = dw_; dh = dh_;
    auto axis = [](int s, int d, std::vector<int>& i0, std::vector<int>& fr) {
      i0.resize(d); fr.resize(d);
      for (int i = 0; i < d; i++) {
        // центр выходного пикселя → координата источника (fixed 8 бит)
        int64_t pos = ((int64_t)(2 * i + 1) * s * 256) / (2 * d) - 128;
        if (pos < 0) pos = 0;
        int ip = (int)(pos >> 8), f = (int)(pos & 255);
        if (ip >= s - 1) { ip = s - 1; f = 0; }
        i0[i] = ip; fr[i] = f;
      }
    };
    axis(sw, dw, x0, xf);
    axis(sh, dh, y0, yf);
    rgb.assign((size_t)dw * 6, 0);
  }

  // одна выходная строка → rgb[row]
  void sampleRow(const uint8_t* src, int stride, int y, int row) {
    int* out = &rgb[(size_t)row * dw * 3];
    const uint8_t* r0 = src + (size_t)y0[y] * stride;
    const uint8_t* r1 = src + (size_t)std::min(y0[y] + 1, sh - 1) * stride;
    int fy = yf[y];
    if (sw == dw && fy == 0) {
      for (int x = 0; x < dw; x++) { const uint8_t* p = r0 + x * 4; out[x * 3] = p[2]; out[x * 3 + 1] = p[1]; out[x * 3 + 2] = p[0]; }
      return;
    }
    for (int x = 0; x < dw; x++) {
      int xa = x0[x], xb = std::min(xa + 1, sw - 1), fx = xf[x];
      const uint8_t *a = r0 + xa * 4, *b = r0 + xb * 4, *c = r1 + xa * 4, *d = r1 + xb * 4;
      for (int k = 0; k < 3; k++) {
        int top = a[k] * (256 - fx) + b[k] * fx;
        int bot = c[k] * (256 - fx) + d[k] * fx;
        out[x * 3 + (2 - k)] = (top * (256 - fy) + bot * fy + 32768) >> 16;
      }
    }
  }

  void convert(const uint8_t* src, int stride, uint8_t* dst) {
    uint8_t* Y = dst;
    uint8_t* U = Y + (size_t)dw * dh;
    uint8_t* V = U + (size_t)(dw / 2) * (dh / 2);
    for (int y = 0; y < dh; y += 2) {
      sampleRow(src, stride, y, 0);
      sampleRow(src, stride, y + 1, 1);
      const int* a = &rgb[0];
      const int* b = &rgb[(size_t)dw * 3];
      uint8_t* ya = Y + (size_t)y * dw;
      uint8_t* yb = ya + dw;
      uint8_t* u = U + (size_t)(y / 2) * (dw / 2);
      uint8_t* v = V + (size_t)(y / 2) * (dw / 2);
      for (int x = 0; x < dw; x += 2) {
        const int *p0 = a + x * 3, *p1 = p0 + 3, *p2 = b + x * 3, *p3 = p2 + 3;
        ya[x] = toY(p0[0], p0[1], p0[2]); ya[x + 1] = toY(p1[0], p1[1], p1[2]);
        yb[x] = toY(p2[0], p2[1], p2[2]); yb[x + 1] = toY(p3[0], p3[1], p3[2]);
        int r = (p0[0] + p1[0] + p2[0] + p3[0] + 2) >> 2;
        int g = (p0[1] + p1[1] + p2[1] + p3[1] + 2) >> 2;
        int bl = (p0[2] + p1[2] + p2[2] + p3[2] + 2) >> 2;
        u[x / 2] = toU(r, g, bl);
        v[x / 2] = toV(r, g, bl);
      }
    }
  }
};

// ---------------------------------------------------------------- курсор
// Рисуем текущий системный курсор в кадр (BGRA, верх-вниз). origin — левый верхний угол кадра
// в физических координатах виртуального экрана. Только чтение состояния курсора — сам курсор не меняется.
struct CursorPainter {
  HDC dc = nullptr;
  HBITMAP bmp = nullptr;
  HGDIOBJ old = nullptr;
  uint8_t* bits = nullptr;
  int cw = 0, ch = 0;
  HCURSOR srcCursor = nullptr;
  HICON cur = nullptr;
  int w = 0, h = 0, hx = 0, hy = 0;

  ~CursorPainter() { release(); if (cur) DestroyIcon(cur); }
  void release() {
    if (dc) { if (old) SelectObject(dc, old); DeleteDC(dc); dc = nullptr; }
    if (bmp) { DeleteObject(bmp); bmp = nullptr; }
    bits = nullptr; cw = ch = 0;
  }
  bool ensure(int w, int h) {
    if (dc && w <= cw && h <= ch) return true;
    release();
    BITMAPINFO bi = {};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    dc = CreateCompatibleDC(nullptr);
    void* p = nullptr;
    bmp = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &p, nullptr, 0);
    if (!dc || !bmp) { release(); return false; }
    old = SelectObject(dc, bmp);
    bits = static_cast<uint8_t*>(p);
    cw = w; ch = h;
    return true;
  }

  void paint(uint8_t* frame, int fw, int fh, int stride, POINT origin) {
    CURSORINFO ci = {};
    ci.cbSize = sizeof ci;
    if (const char* t = getenv("SOZVON_CAPTURE_TEST_CURSOR")) {  // только для автотестов: стрелка в точке X,Y
      long x = 0, y = 0;
      sscanf(t, "%ld,%ld", &x, &y);
      ci.hCursor = LoadCursor(nullptr, IDC_ARROW); ci.flags = CURSOR_SHOWING; ci.ptScreenPos = { x, y };
    } else if (!GetCursorInfo(&ci) || !(ci.flags & CURSOR_SHOWING) || !ci.hCursor) return;
    // копия курсора (по чужому HCURSOR GetIconInfo/DrawIconEx в некоторых средах отказывают);
    // пересоздаём только при смене курсора
    if (ci.hCursor != srcCursor) {
      if (cur) { DestroyIcon(cur); cur = nullptr; }
      srcCursor = ci.hCursor;
      cur = CopyIcon(ci.hCursor);
      ICONINFO ii = {};
      if (cur && GetIconInfo(cur, &ii)) {
        BITMAP bm = {};
        w = 32; h = 32;
        if (ii.hbmColor && GetObject(ii.hbmColor, sizeof bm, &bm)) { w = bm.bmWidth; h = bm.bmHeight; }
        else if (ii.hbmMask && GetObject(ii.hbmMask, sizeof bm, &bm)) { w = bm.bmWidth; h = bm.bmHeight / 2; }
        if (ii.hbmColor) DeleteObject(ii.hbmColor);
        if (ii.hbmMask) DeleteObject(ii.hbmMask);
        hx = (int)ii.xHotspot; hy = (int)ii.yHotspot;
        if (w <= 0 || h <= 0 || w > 512 || h > 512) { DestroyIcon(cur); cur = nullptr; }
      } else if (cur) { DestroyIcon(cur); cur = nullptr; }
    }
    if (!cur) return;
    int left = ci.ptScreenPos.x - hx - origin.x;
    int top = ci.ptScreenPos.y - hy - origin.y;
    int x0 = std::max(left, 0), y0 = std::max(top, 0);
    int x1 = std::min(left + w, fw), y1 = std::min(top + h, fh);
    if (x0 >= x1 || y0 >= y1 || !ensure(std::max(w, 32), std::max(h, 32))) return;
    GdiFlush();
    // фон под курсором → DIB, курсор поверх (DrawIconEx сам учитывает альфу/маску/инверсию), обратно
    for (int y = y0; y < y1; y++)
      memcpy(bits + (size_t)(y - top) * cw * 4 + (size_t)(x0 - left) * 4, frame + (size_t)y * stride + (size_t)x0 * 4, (size_t)(x1 - x0) * 4);
    DrawIconEx(dc, 0, 0, cur, w, h, 0, nullptr, DI_NORMAL);
    GdiFlush();
    for (int y = y0; y < y1; y++)
      memcpy(frame + (size_t)y * stride + (size_t)x0 * 4, bits + (size_t)(y - top) * cw * 4 + (size_t)(x0 - left) * 4, (size_t)(x1 - x0) * 4);
  }
};

// ---------------------------------------------------------------- DXGI Desktop Duplication
struct Dda {
  Com<ID3D11Device> dev;
  Com<ID3D11DeviceContext> ctx;
  Com<IDXGIOutputDuplication> dup;
  Com<ID3D11Texture2D> staging;
  int stW = 0, stH = 0;
  HMONITOR mon = nullptr;
  RECT monRect = {};
  bool holding = false;

  void reset() {
    if (dup && holding) dup->ReleaseFrame();
    holding = false;
    staging.reset(); stW = stH = 0;
    dup.reset(); ctx.reset(); dev.reset();
    mon = nullptr;
  }

  // 1 — готово, 0 — временно нельзя (UAC/смена режима — повторить позже), -1 — не поддерживается
  int init(HMONITOR target) {
    reset();
    Com<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)factory.put()))) return -1;
    for (UINT ai = 0;; ai++) {
      Com<IDXGIAdapter1> adapter;
      if (factory->EnumAdapters1(ai, adapter.put()) == DXGI_ERROR_NOT_FOUND) break;
      for (UINT oi = 0;; oi++) {
        Com<IDXGIOutput> out;
        if (adapter->EnumOutputs(oi, out.put()) == DXGI_ERROR_NOT_FOUND) break;
        DXGI_OUTPUT_DESC od;
        if (FAILED(out->GetDesc(&od)) || od.Monitor != target) continue;
        if (od.Rotation != DXGI_MODE_ROTATION_IDENTITY && od.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
          logf("монитор повёрнут — DXGI пропускаем, будет GDI");
          return -1;
        }
        static const D3D_FEATURE_LEVEL levels[] = { D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0 };
        HRESULT hr = D3D11CreateDevice(adapter.p, D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                       levels, 3, D3D11_SDK_VERSION, dev.put(), nullptr, ctx.put());
        if (FAILED(hr)) { logf("D3D11CreateDevice: 0x%08lx", (unsigned long)hr); return -1; }
        Com<IDXGIOutput1> out1;
        if (FAILED(out->QueryInterface(__uuidof(IDXGIOutput1), (void**)out1.put()))) return -1;
        hr = out1->DuplicateOutput(dev.p, dup.put());
        if (hr == E_ACCESSDENIED || hr == DXGI_ERROR_SESSION_DISCONNECTED) { logf("DuplicateOutput: временно недоступно (0x%08lx)", (unsigned long)hr); return 0; }
        if (FAILED(hr)) { logf("DuplicateOutput: 0x%08lx", (unsigned long)hr); return -1; }
        DXGI_OUTDUPL_DESC dd;
        dup->GetDesc(&dd);
        if (dd.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM && dd.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM_SRGB) {
          logf("формат рабочего стола %d (HDR?) — будет GDI", (int)dd.ModeDesc.Format);
          reset();
          return -1;
        }
        mon = target;
        monRect = od.DesktopCoordinates;
        logf("DXGI Desktop Duplication: %ldx%ld", monRect.right - monRect.left, monRect.bottom - monRect.top);
        return 1;
      }
    }
    logf("монитор не найден среди выходов DXGI");
    return -1;
  }

  // crop — в координатах монитора. 1 — кадр в dst, 0 — нет нового кадра, -1 — потерян (переинициализировать)
  int grab(UINT timeoutMs, const RECT& crop, uint8_t* dst, int dstStride) {
    if (holding) { dup->ReleaseFrame(); holding = false; }
    DXGI_OUTDUPL_FRAME_INFO info;
    Com<IDXGIResource> res;
    HRESULT hr = dup->AcquireNextFrame(timeoutMs, &info, res.put());
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) return 0;
    if (FAILED(hr)) { logf("AcquireNextFrame: 0x%08lx", (unsigned long)hr); return -1; }
    holding = true;
    Com<ID3D11Texture2D> tex;
    if (FAILED(res->QueryInterface(__uuidof(ID3D11Texture2D), (void**)tex.put()))) return -1;
    int w = crop.right - crop.left, h = crop.bottom - crop.top;
    if (!staging || stW != w || stH != h) {
      D3D11_TEXTURE2D_DESC td;
      tex->GetDesc(&td);
      td.Width = w; td.Height = h; td.MipLevels = 1; td.ArraySize = 1;
      td.SampleDesc.Count = 1; td.SampleDesc.Quality = 0;
      td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ; td.MiscFlags = 0;
      if (FAILED(dev->CreateTexture2D(&td, nullptr, staging.put()))) return -1;
      stW = w; stH = h;
    }
    D3D11_BOX box = { (UINT)crop.left, (UINT)crop.top, 0, (UINT)crop.right, (UINT)crop.bottom, 1 };
    ctx->CopySubresourceRegion(staging.p, 0, 0, 0, 0, tex.p, 0, &box);
    dup->ReleaseFrame();
    holding = false;
    D3D11_MAPPED_SUBRESOURCE m;
    if (FAILED(ctx->Map(staging.p, 0, D3D11_MAP_READ, 0, &m))) return -1;
    for (int y = 0; y < h; y++) memcpy(dst + (size_t)y * dstStride, (uint8_t*)m.pData + (size_t)y * m.RowPitch, (size_t)w * 4);
    ctx->Unmap(staging.p, 0);
    return 1;
  }
};

// ---------------------------------------------------------------- GDI (запасной путь, без CAPTUREBLT)
struct Gdi {
  HDC screen = nullptr, mem = nullptr;
  HBITMAP bmp = nullptr;
  HGDIOBJ old = nullptr;
  uint8_t* bits = nullptr;
  int w = 0, h = 0;
  ~Gdi() { release(); }
  void release() {
    if (mem) { if (old) SelectObject(mem, old); DeleteDC(mem); mem = nullptr; }
    if (bmp) { DeleteObject(bmp); bmp = nullptr; }
    if (screen) { ReleaseDC(nullptr, screen); screen = nullptr; }
    bits = nullptr; w = h = 0;
  }
  // rect — физические координаты виртуального экрана
  bool grab(const RECT& r, uint8_t* dst, int dstStride) {
    int rw = r.right - r.left, rh = r.bottom - r.top;
    if (!screen || rw != w || rh != h) {
      release();
      screen = GetDC(nullptr);
      mem = CreateCompatibleDC(screen);
      BITMAPINFO bi = {};
      bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
      bi.bmiHeader.biWidth = rw; bi.bmiHeader.biHeight = -rh;
      bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32; bi.bmiHeader.biCompression = BI_RGB;
      void* p = nullptr;
      bmp = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &p, nullptr, 0);
      if (!screen || !mem || !bmp) { release(); return false; }
      old = SelectObject(mem, bmp);
      bits = static_cast<uint8_t*>(p);
      w = rw; h = rh;
    }
    if (!BitBlt(mem, 0, 0, rw, rh, screen, r.left, r.top, SRCCOPY)) return false;
    GdiFlush();
    for (int y = 0; y < rh; y++) memcpy(dst + (size_t)y * dstStride, bits + (size_t)y * rw * 4, (size_t)rw * 4);
    return true;
  }
};

// ---------------------------------------------------------------- main
struct Args {
  bool keys = false;   // режим «клавиши рации» (Raw Input)
  bool media = false;  // режим «что играет» (системные медиасессии)
  DWORD audioPid = 0;  // режим «звук без процесса»
  bool hasMonitor = false;
  RECT monitor = {};
  HWND hwnd = nullptr;
  int maxW = 1280, maxH = 720, fps = 30;
  bool cursor = true;
  bool listen = false;
  std::string token, origin;
};

static bool parseArgs(int argc, char** argv, Args& a) {
  for (int i = 1; i < argc; i++) {
    const char* k = argv[i];
    const char* v = i + 1 < argc ? argv[i + 1] : nullptr;
    if (!strcmp(k, "--monitor") && v) {
      long x, y, w, h;
      if (sscanf(v, "%ld,%ld,%ld,%ld", &x, &y, &w, &h) != 4 || w <= 0 || h <= 0) return false;
      a.monitor = { x, y, x + w, y + h }; a.hasMonitor = true; i++;
    } else if (!strcmp(k, "--hwnd") && v) {
      a.hwnd = (HWND)(intptr_t)_strtoi64(v, nullptr, 10); i++;
    } else if (!strcmp(k, "--max-width") && v) { a.maxW = atoi(v); i++; }
    else if (!strcmp(k, "--max-height") && v) { a.maxH = atoi(v); i++; }
    else if (!strcmp(k, "--fps") && v) { a.fps = atoi(v); i++; }
    else if (!strcmp(k, "--no-cursor")) a.cursor = false;
    else if (!strcmp(k, "--keys")) a.keys = true;
    else if (!strcmp(k, "--media")) a.media = true;
    else if (!strcmp(k, "--watch") && v) { setWatch(v); i++; }
    else if (!strcmp(k, "--audio-exclude-pid") && v) { a.audioPid = (DWORD)strtoul(v, nullptr, 10); i++; }
    else if (!strcmp(k, "--listen")) a.listen = true;
    else if (!strcmp(k, "--token") && v) { a.token = v; i++; }
    else if (!strcmp(k, "--origin") && v) { a.origin = v; i++; }
    else return false;
  }
  a.maxW = std::min(std::max(a.maxW, 160), 3840);
  a.maxH = std::min(std::max(a.maxH, 90), 2160);
  a.fps = std::min(std::max(a.fps, 1), 60);
  if (a.listen && (a.token.size() < 16 || a.origin.empty() || a.origin.find_first_of("\r\n") != std::string::npos)) return false;
  return a.hasMonitor || a.hwnd || a.audioPid || a.keys || a.media;
}

// ---------------------------------------------------------------- клавиши рации (Raw Input)
// Нормализация как у браузера: левый/правый Ctrl/Shift/Alt, Enter цифрового блока, цифры блока без NumLock
static int normVk(const RAWKEYBOARD& k) {
  int vk = k.VKey;
  bool e0 = (k.Flags & RI_KEY_E0) != 0;
  if (vk == VK_SHIFT) return (int)MapVirtualKeyW(k.MakeCode, MAPVK_VSC_TO_VK_EX);
  if (vk == VK_CONTROL) return e0 ? VK_RCONTROL : VK_LCONTROL;
  if (vk == VK_MENU) return e0 ? VK_RMENU : VK_LMENU;
  if (vk == VK_RETURN && e0) return 256 + VK_RETURN;
  if (!e0) {  // без E0 «навигационные» коды приходят от цифрового блока с выключенным NumLock
    switch (vk) {
      case VK_INSERT: return VK_NUMPAD0;
      case VK_END: return VK_NUMPAD1;
      case VK_DOWN: return VK_NUMPAD2;
      case VK_NEXT: return VK_NUMPAD3;
      case VK_LEFT: return VK_NUMPAD4;
      case VK_CLEAR: return VK_NUMPAD5;
      case VK_RIGHT: return VK_NUMPAD6;
      case VK_HOME: return VK_NUMPAD7;
      case VK_UP: return VK_NUMPAD8;
      case VK_PRIOR: return VK_NUMPAD9;
      case VK_DELETE: return VK_DECIMAL;
    }
  }
  return vk;
}

static int runKeys() {
  HWND wnd = CreateWindowExW(0, L"STATIC", L"sozvon-keys", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, GetModuleHandleW(nullptr), nullptr);
  RAWINPUTDEVICE rid = { 0x01 /* Generic Desktop */, 0x06 /* Keyboard */, RIDEV_INPUTSINK, wnd };
  if (!wnd || !RegisterRawInputDevices(&rid, 1, sizeof rid)) { logf("Raw Input недоступен (%lu)", GetLastError()); return 4; }
  logf("клавиши: Raw Input (без перехвата ввода)");
  printf("READY\n");
  fflush(stdout);
  bool down[512] = {};
  std::vector<uint8_t> buf(256);
  while (!g_quit) {
    MsgWaitForMultipleObjects(0, nullptr, FALSE, 200, QS_ALLINPUT);
    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_INPUT) {
        UINT size = 0;
        GetRawInputData((HRAWINPUT)msg.lParam, RID_INPUT, nullptr, &size, sizeof(RAWINPUTHEADER));
        if (size && size <= 4096) {
          if (buf.size() < size) buf.resize(size);
          if (GetRawInputData((HRAWINPUT)msg.lParam, RID_INPUT, buf.data(), &size, sizeof(RAWINPUTHEADER)) != (UINT)-1) {
            const RAWINPUT* ri = reinterpret_cast<const RAWINPUT*>(buf.data());
            if (ri->header.dwType == RIM_TYPEKEYBOARD && ri->data.keyboard.VKey && ri->data.keyboard.VKey != 0xFF) {
              int vk = normVk(ri->data.keyboard);
              bool isDown = !(ri->data.keyboard.Flags & RI_KEY_BREAK);
              if (vk > 0 && vk < 512 && down[vk] != isDown) {
                down[vk] = isDown;
                if (g_watch[vk]) { printf("%c %d\n", isDown ? 'd' : 'u', vk); fflush(stdout); }
              }
            }
          }
        }
      }
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
  }
  DestroyWindow(wnd);
  return 0;
}

// ---------------------------------------------------------------- что играет (системные медиасессии)
// Режим --media: то же, что показывает регулятор громкости Windows 10/11 (GlobalSystemMediaTransportControls):
// Spotify, Яндекс Музыка, AIMP, браузеры… — всё, что публикует сессию. Опрос раз в секунду (дёшево и не зависит
// от того, присылает ли плеер события). Строка JSON в stdout на каждое изменение и не чаще раза в 5 с, пока играет.
static long long unixMsNow() {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER u;
  u.LowPart = ft.dwLowDateTime;
  u.HighPart = ft.dwHighDateTime;
  return (long long)((u.QuadPart - 116444736000000000ull) / 10000ull);
}

static void jsonEsc(std::string& out, const std::string& s) {
  out += '"';
  for (unsigned char c : s) {
    if (c == '"') out += "\\\"";
    else if (c == '\\') out += "\\\\";
    else if (c < 0x20 || c == 0x7f) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); out += b; }
    else out += (char)c;
  }
  out += '"';
}

struct MediaInfo {
  std::string app, title, artist, album, albumArtist;
  long long durationMs = 0, positionMs = 0, updatedAt = 0;
  bool playing = false, current = false;
  std::string key() const {  // без позиции: она меняется сама по себе
    std::string k;
    jsonEsc(k, app); jsonEsc(k, title); jsonEsc(k, artist); jsonEsc(k, album);
    k += std::to_string(durationMs) + (playing ? "P" : "-") + (current ? "C" : "-");
    return k;
  }
  // где сейчас трек (мс), с учётом времени после LastUpdatedTime
  long long posAt(long long now) const {
    long long p = positionMs;
    if (playing && updatedAt > 0 && now > updatedAt) p += now - updatedAt;
    if (durationMs > 0 && p > durationMs) p = durationMs;
    return p < 0 ? 0 : p;
  }
};

static std::string mediaJson(const std::vector<MediaInfo>& list) {
  std::string s = "{\"t\":\"media\",\"sessions\":[";
  for (size_t i = 0; i < list.size(); i++) {
    const MediaInfo& m = list[i];
    if (i) s += ',';
    s += "{\"app\":"; jsonEsc(s, m.app);
    s += ",\"title\":"; jsonEsc(s, m.title);
    s += ",\"artist\":"; jsonEsc(s, m.artist);
    s += ",\"album\":"; jsonEsc(s, m.album);
    s += ",\"albumArtist\":"; jsonEsc(s, m.albumArtist);
    s += ",\"durationMs\":" + std::to_string(m.durationMs);
    s += ",\"positionMs\":" + std::to_string(m.positionMs);
    s += ",\"updatedAt\":" + std::to_string(m.updatedAt);
    s += ",\"playing\":"; s += m.playing ? "true" : "false";
    s += ",\"current\":"; s += m.current ? "true" : "false";
    s += '}';
  }
  s += "]}\n";
  return s;
}

// Цикл опроса: changed/heartbeat. read(list) → false, если источник «умер» (запросить заново).
template <class Read, class Reopen>
static int mediaLoop(Read read, Reopen reopen) {
  std::string lastKey;
  std::vector<long long> lastPos;  // позиции на момент последней отправки (по порядку сессий)
  long long lastSent = 0;
  bool first = true;
  std::vector<MediaInfo> list;
  while (!g_quit) {
    if (!read(list)) {
      if (!reopen()) { for (int i = 0; i < 50 && !g_quit; i++) Sleep(100); }
      continue;
    }
    long long now = unixMsNow();
    std::string key;
    bool anyPlaying = false;
    for (const auto& m : list) { key += m.key(); key += '\n'; anyPlaying = anyPlaying || m.playing; }
    bool changed = first || key != lastKey;
    // перемотка: позиция ушла от ожидаемой больше чем на 2,5 с
    if (!changed && lastPos.size() == list.size()) {
      for (size_t i = 0; i < list.size(); i++) {
        // позиция идёт сама, только если плеер сообщил, на какой момент она (updatedAt); иначе стоит на месте
        long long expect = lastPos[i] + (list[i].playing && list[i].updatedAt > 0 ? now - lastSent : 0);
        if (list[i].durationMs > 0 && expect > list[i].durationMs) expect = list[i].durationMs;
        long long d = list[i].posAt(now) - expect;
        if (d > 2500 || d < -2500) { changed = true; break; }
      }
    }
    if (changed || (anyPlaying && now - lastSent >= 5000)) {
      std::string line = mediaJson(list);
      if (fwrite(line.data(), 1, line.size(), stdout) != line.size() || fflush(stdout)) break;  // приложение закрыло канал
      lastKey = key;
      lastSent = now;
      lastPos.clear();
      for (const auto& m : list) lastPos.push_back(m.posAt(now));
      first = false;
    }
    for (int i = 0; i < 10 && !g_quit; i++) Sleep(100);
  }
  return 0;
}

#ifdef _MSC_VER
static std::string utf8(const winrt::hstring& h) {
  if (h.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, h.c_str(), (int)h.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n : 0, '\0');
  if (n > 0) WideCharToMultiByte(CP_UTF8, 0, h.c_str(), (int)h.size(), &s[0], n, nullptr, nullptr);
  if (s.size() > 1000) s.resize(1000);  // защита от мусора; приложение всё равно обрезает до 200
  return s;
}

namespace wmc = winrt::Windows::Media::Control;
namespace wf = winrt::Windows::Foundation;

static wmc::GlobalSystemMediaTransportControlsSessionManager requestManager() {
  auto op = wmc::GlobalSystemMediaTransportControlsSessionManager::RequestAsync();
  if (op.wait_for(std::chrono::seconds(15)) != wf::AsyncStatus::Completed) return nullptr;
  return op.GetResults();
}

static long long msOf(wf::TimeSpan t) {
  return (long long)std::chrono::duration_cast<std::chrono::milliseconds>(t).count();
}

static bool readSessions(const wmc::GlobalSystemMediaTransportControlsSessionManager& mgr, std::vector<MediaInfo>& list) {
  list.clear();
  if (!mgr) return false;
  std::string currentApp;
  wf::Collections::IVectorView<wmc::GlobalSystemMediaTransportControlsSession> sessions{ nullptr };
  try {
    auto cur = mgr.GetCurrentSession();
    if (cur) currentApp = utf8(cur.SourceAppUserModelId());
    sessions = mgr.GetSessions();
  } catch (...) {
    return false;  // менеджер «умер» (перезапуск проводника, выход из сна) — запросим заново
  }
  for (const auto& s : sessions) {
    try {
      MediaInfo m;
      m.app = utf8(s.SourceAppUserModelId());
      auto op = s.TryGetMediaPropertiesAsync();
      if (op.wait_for(std::chrono::seconds(3)) != wf::AsyncStatus::Completed) continue;
      auto p = op.GetResults();
      if (!p) continue;
      m.title = utf8(p.Title());
      m.artist = utf8(p.Artist());
      m.album = utf8(p.AlbumTitle());
      m.albumArtist = utf8(p.AlbumArtist());
      if (m.title.empty() && m.artist.empty()) continue;
      auto pb = s.GetPlaybackInfo();
      m.playing = pb && pb.PlaybackStatus() == wmc::GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
      m.current = !currentApp.empty() && m.app == currentApp;
      try {
        auto tl = s.GetTimelineProperties();
        if (tl) {
          long long start = msOf(tl.StartTime()), end = msOf(tl.EndTime()), pos = msOf(tl.Position());
          m.durationMs = end > start ? end - start : 0;
          m.positionMs = pos > start ? pos - start : 0;
          // DateTime — такты по 100 нс от 1601 года; «не задано» — 0 или что-то до 2000 года
          long long ticks = (long long)tl.LastUpdatedTime().time_since_epoch().count();
          long long ms = (ticks - 116444736000000000ll) / 10000ll;
          m.updatedAt = ms > 946684800000ll ? ms : 0;
        }
      } catch (...) {
        m.durationMs = m.positionMs = m.updatedAt = 0;
      }
      if (m.durationMs < 0 || m.durationMs > 24ll * 3600 * 1000) m.durationMs = 0;
      list.push_back(std::move(m));
    } catch (...) {
      // сессия закрылась между перечислением и чтением — пропускаем
    }
  }
  return true;
}

static int runMedia() {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
  } catch (const winrt::hresult_error& e) {
    logf("WinRT недоступен (0x%08lx)", (unsigned long)e.code().value);
    return 4;
  }
  wmc::GlobalSystemMediaTransportControlsSessionManager mgr{ nullptr };
  try {
    mgr = requestManager();
  } catch (const winrt::hresult_error& e) {
    logf("медиасессии недоступны (0x%08lx)", (unsigned long)e.code().value);
    return 4;
  } catch (...) {
    mgr = nullptr;
  }
  if (!mgr) { logf("медиасессии недоступны (нет GlobalSystemMediaTransportControlsSessionManager)"); return 4; }
  logf("медиа: системные медиасессии Windows");
  fputs("READY\n", stdout);
  fflush(stdout);
  return mediaLoop(
      [&](std::vector<MediaInfo>& list) { return readSessions(mgr, list); },
      [&]() {
        try { mgr = requestManager(); } catch (...) { mgr = nullptr; }
        return (bool)mgr;
      });
}
#else
// Без MSVC (проверка синтаксиса mingw-w64): заголовков C++/WinRT нет — режим недоступен
static int runMedia() {
  logf("медиасессии: сборка без C++/WinRT");
  return 4;
}
#endif

// ---------------------------------------------------------------- звук без своего процесса
// ActivateAudioInterfaceAsync завершается колбэком в другом потоке — ждём его событием
class ActivateHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
  LONG ref_ = 1;
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT hr = E_FAIL;
  IAudioClient* client = nullptr;
  ~ActivateHandler() { if (done) CloseHandle(done); }
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    else if (riid == __uuidof(IAgileObject)) *ppv = static_cast<IAgileObject*>(this);
    else { *ppv = nullptr; return E_NOINTERFACE; }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return (ULONG)InterlockedIncrement(&ref_); }
  STDMETHODIMP_(ULONG) Release() override {
    LONG r = InterlockedDecrement(&ref_);
    if (!r) delete this;
    return (ULONG)r;
  }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT act = E_FAIL;
    IUnknown* unk = nullptr;
    HRESULT h = op->GetActivateResult(&act, &unk);
    if (SUCCEEDED(h) && SUCCEEDED(act) && unk) {
      h = unk->QueryInterface(__uuidof(IAudioClient), (void**)&client);
      hr = SUCCEEDED(h) && client ? S_OK : E_NOINTERFACE;
    } else {
      hr = FAILED(h) ? h : act;
    }
    if (unk) unk->Release();
    SetEvent(done);
    return S_OK;
  }
};

static const UINT32 A_RATE = 48000, A_CH = 2, A_BLOCK = A_CH * 2;
struct AudioCap {
  Com<IAudioClient> client;
  Com<IAudioCaptureClient> cap;
  HANDLE ev = nullptr;
  ~AudioCap() { if (client) client->Stop(); if (ev) CloseHandle(ev); }
  // 0 — готово; 4 — недоступно. Вызывается ДО открытия порта: приложение сразу узнаёт, что нужен запасной путь
  int init(DWORD pid) {
    const UINT32 RATE = A_RATE, CH = A_CH, BLOCK = A_BLOCK;
    AUDIOCLIENT_ACTIVATION_PARAMS ap = {};
    ap.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    ap.ProcessLoopbackParams.TargetProcessId = pid;
    ap.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT pv = {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof ap;
    pv.blob.pBlobData = reinterpret_cast<BYTE*>(&ap);
    ActivateHandler* handler = new ActivateHandler();
    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler, &op);
    if (SUCCEEDED(hr) && WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0) hr = HRESULT_FROM_WIN32(WAIT_TIMEOUT);
    else if (SUCCEEDED(hr)) hr = handler->hr;
    if (SUCCEEDED(hr)) { client.p = handler->client; handler->client = nullptr; }
    if (op) op->Release();
    handler->Release();
    if (FAILED(hr) || !client) { logf("process loopback недоступен (0x%08lx)", (unsigned long)hr); return 4; }

    WAVEFORMATEX wf = {};
    wf.wFormatTag = WAVE_FORMAT_PCM;
    wf.nChannels = (WORD)CH;
    wf.nSamplesPerSec = RATE;
    wf.wBitsPerSample = 16;
    wf.nBlockAlign = (WORD)BLOCK;
    wf.nAvgBytesPerSec = RATE * BLOCK;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                            200000 /* 20 мс */, 0, &wf, nullptr);
    if (FAILED(hr)) { logf("IAudioClient::Initialize 0x%08lx", (unsigned long)hr); return 4; }
    ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (FAILED(client->SetEventHandle(ev)) || FAILED(client->GetService(__uuidof(IAudioCaptureClient), (void**)cap.put())) || FAILED(client->Start())) {
      logf("захват звука не запустился");
      return 4;
    }
    logf("звук: системный без процесса %lu, %u Гц, %u кан.", (unsigned long)pid, RATE, CH);
    return 0;
  }

  int loop(Sink& out) {
    const UINT32 RATE = A_RATE, CH = A_CH, BLOCK = A_BLOCK;

    const uint64_t t0 = nowUs();
    uint64_t sent = 0;  // отправлено кадров (сэмплов на канал) — для тишины в реальном темпе
    std::vector<uint8_t> pkt;
    auto emit = [&](const uint8_t* pcm, UINT32 frames) -> bool {
      uint32_t len = frames * BLOCK;
      uint32_t hdr[6] = { 0x31415A53 /* 'SZA1' */, RATE, CH, len, 0, 0 };
      uint64_t ts = t0 + sent * 1000000ull / RATE;
      memcpy(&hdr[4], &ts, 8);
      pkt.resize(sizeof hdr + len);
      memcpy(pkt.data(), hdr, sizeof hdr);
      if (pcm) memcpy(pkt.data() + sizeof hdr, pcm, len); else memset(pkt.data() + sizeof hdr, 0, len);
      sent += frames;
      return out.write(pkt.data(), pkt.size());
    };
    bool alive = true;
    while (alive && !g_quit) {
      WaitForSingleObject(ev, 10);
      UINT32 n = 0;
      while (alive && SUCCEEDED(cap->GetNextPacketSize(&n)) && n) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
        if (!g_paused && frames) alive = emit((flags & AUDCLNT_BUFFERFLAGS_SILENT) ? nullptr : data, frames);
        cap->ReleaseBuffer(frames);
      }
      // ничего не играет — Windows пакетов не шлёт; добиваем тишиной, если отстали больше чем на 30 мс
      uint64_t due = (nowUs() - t0) * RATE / 1000000ull;
      if (alive && due > sent + RATE * 30 / 1000) {
        if (g_paused) sent = due;  // на паузе ничего не шлём, только двигаем часы
        else while (alive && due > sent + RATE / 100) alive = emit(nullptr, RATE / 100);
      }
    }
    return 0;
  }
};

static void fitSize(int sw, int sh, int maxW, int maxH, int& dw, int& dh) {
  double k = std::min(1.0, std::min((double)maxW / sw, (double)maxH / sh));
  dw = std::max(2, (int)(sw * k) & ~1);
  dh = std::max(2, (int)(sh * k) & ~1);
}

static RECT monitorRect(HMONITOR m) {
  MONITORINFO mi = {};
  mi.cbSize = sizeof mi;
  GetMonitorInfo(m, &mi);
  return mi.rcMonitor;
}

int main(int argc, char** argv) {
  Args a;
  if (!parseArgs(argc, argv, a)) {
    fprintf(stderr, "usage: sozvon-capture (--monitor X,Y,W,H | --hwnd N | --audio-exclude-pid PID | --keys [--watch VK,…] | --media) [--max-width W] [--max-height H] [--fps F] [--no-cursor] [--listen --token T --origin O]\n");
    return 2;
  }
  // физические пиксели во всех API (позиция курсора, рамка окна, координаты мониторов)
  typedef BOOL(WINAPI * SetCtx)(HANDLE);
  if (auto f = (SetCtx)(void*)GetProcAddress(GetModuleHandleA("user32.dll"), "SetProcessDpiAwarenessContext")) f((HANDLE)-4 /* PER_MONITOR_AWARE_V2 */);
  else SetProcessDPIAware();
  if (a.media) {  // текстовый режим: строки JSON (UTF-8) в stdout, конец stdin — выход
    _setmode(_fileno(stdout), _O_BINARY);
    CreateThread(nullptr, 0, stdinThread, nullptr, 0, nullptr);
    return runMedia();
  }
  if (a.keys) {  // текстовый режим: stdin-команды и строки d/u в stdout
    CreateThread(nullptr, 0, stdinThread, nullptr, 0, nullptr);
    return runKeys();
  }
  _setmode(_fileno(stdout), _O_BINARY);
  timeBeginPeriod(1);
  CreateThread(nullptr, 0, stdinThread, nullptr, 0, nullptr);
  Sink out;
  out.h = GetStdHandle(STD_OUTPUT_HANDLE);
  AudioCap audioCap;
  if (a.audioPid) {
    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) { logf("COM недоступен"); return 4; }
    if (int rc = audioCap.init(a.audioPid)) return rc;
  }
  if (a.listen) {
    out.s = acceptClient(a.token, a.origin);
    if (out.s == INVALID_SOCKET) return g_quit ? 0 : 4;
  }
  if (a.audioPid) {
    int rc = audioCap.loop(out);
    timeEndPeriod(1);
    return rc;
  }

  Dda dda;
  Gdi gdi;
  CursorPainter cursor;
  Scaler scaler;
  bool useDda = true;
  uint64_t ddaRetryAt = 0;
  std::vector<uint8_t> bgra, i420;
  int lastDw = 0, lastDh = 0;
  const uint64_t interval = 1000000ull / a.fps;
  const uint64_t keepAlive = 200000;  // без изменений на экране — повтор кадра 5 раз/с (для новых зрителей)
  uint64_t nextAt = nowUs(), lastSent = 0;
  bool haveFrame = false;

  while (!g_quit) {
    if (g_paused) { dda.reset(); Sleep(50); nextAt = nowUs(); continue; }

    // источник: прямоугольник в координатах виртуального экрана и его монитор
    RECT src;
    HMONITOR mon;
    if (a.hwnd) {
      if (!IsWindow(a.hwnd)) { logf("окно закрыто"); return 3; }
      if (IsIconic(a.hwnd)) { Sleep(100); continue; }
      if (FAILED(DwmGetWindowAttribute(a.hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &src, sizeof src))) GetWindowRect(a.hwnd, &src);
      mon = MonitorFromWindow(a.hwnd, MONITOR_DEFAULTTONEAREST);
      RECT mr = monitorRect(mon), cut;
      if (!IntersectRect(&cut, &src, &mr)) { Sleep(100); continue; }
      src = cut;
    } else {
      POINT c = { (a.monitor.left + a.monitor.right) / 2, (a.monitor.top + a.monitor.bottom) / 2 };
      mon = MonitorFromPoint(c, MONITOR_DEFAULTTONEAREST);
      src = monitorRect(mon);
    }
    int sw = (src.right - src.left) & ~1, sh = (src.bottom - src.top) & ~1;
    if (sw < 2 || sh < 2) { Sleep(100); continue; }
    src.right = src.left + sw; src.bottom = src.top + sh;
    if ((int)bgra.size() < sw * sh * 4) bgra.resize((size_t)sw * sh * 4);

    // ждём момент следующего кадра, затем забираем самое свежее изображение
    uint64_t now = nowUs();
    if (nextAt > now + 1000) { Sleep((DWORD)((nextAt - now) / 1000)); now = nowUs(); }
    nextAt = std::max(nextAt + interval, now);
    int got = 0;
    if (useDda && (!dda.dup || dda.mon != mon)) {
      if (now >= ddaRetryAt) {
        int r = dda.init(mon);
        if (r < 0) { useDda = false; logf("переключаюсь на GDI"); }
        else if (r == 0) ddaRetryAt = now + 1000000;
      }
    }
    if (useDda && dda.dup) {
      RECT crop = { src.left - dda.monRect.left, src.top - dda.monRect.top, src.right - dda.monRect.left, src.bottom - dda.monRect.top };
      got = dda.grab(haveFrame ? 0 : 100, crop, bgra.data(), sw * 4);
      if (got < 0) { dda.reset(); ddaRetryAt = nowUs() + 200000; got = 0; }
    } else {
      got = gdi.grab(src, bgra.data(), sw * 4) ? 1 : 0;
    }

    now = nowUs();
    if (got) {
      if (a.cursor) cursor.paint(bgra.data(), sw, sh, sw * 4, POINT{ src.left, src.top });
      int dw, dh;
      fitSize(sw, sh, a.maxW, a.maxH, dw, dh);
      if (dw != lastDw || dh != lastDh) { lastDw = dw; lastDh = dh; logf("кадр %dx%d -> %dx%d", sw, sh, dw, dh); }
      i420.resize((size_t)dw * dh * 3 / 2);
      scaler.setup(sw, sh, dw, dh);
      scaler.convert(bgra.data(), sw * 4, i420.data());
      haveFrame = true;
    } else if (!haveFrame || now - lastSent < keepAlive) {
      continue;
    }
    uint32_t hdr[6] = { 0x31435A53 /* 'SZC1' */, (uint32_t)lastDw, (uint32_t)lastDh, (uint32_t)i420.size(), 0, 0 };
    uint64_t ts = now;
    memcpy(&hdr[4], &ts, 8);
    if (!out.write(hdr, sizeof hdr) || !out.write(i420.data(), i420.size())) break;  // приложение закрыло канал
    lastSent = now;
  }
  timeEndPeriod(1);
  return 0;
}
