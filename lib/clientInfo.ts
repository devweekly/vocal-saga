/**
 * 客户端浏览器信息提取与日志格式化。
 *
 * 用途：当服务端翻译（`POST /fanyi/page`）出错时，错误日志里能直接看到
 * 是哪个浏览器、是否移动端、屏幕多大——这对定位「Firefox Android 失败、
 * Chrome 成功」这类客户端差异问题很关键。
 *
 * 信息来源（两者合并，body.client 优先于 UA header）：
 *  - 扩展端在请求体里带来的精确 `client` 对象（真实屏幕/视口尺寸、platform、touch）。
 *  - 请求头 `User-Agent`：服务端据此解析 browser / os / deviceType（无需扩展改动也能用）。
 */

export interface ClientInfo {
  /** 完整 User-Agent 字符串（来自 body.client.ua 或请求头） */
  ua?: string;
  /** 浏览器：Firefox / Chrome / Safari / Edge / Opera / Unknown */
  browser?: string;
  /** 浏览器大版本号，如 "115.0" */
  browserVersion?: string;
  /** 操作系统：Android / iOS / Windows / macOS / Linux / Unknown */
  os?: string;
  /** 设备形态：mobile / tablet / desktop */
  deviceType?: 'mobile' | 'tablet' | 'desktop' | string;
  /** 是否移动端（来自 body.client.isMobile 或 UA 推导） */
  isMobile?: boolean;
  /** 是否触屏设备（来自 body.client.touch） */
  touch?: boolean;
  /** 屏幕宽度（设备像素，来自 body.client.screenWidth） */
  screenWidth?: number;
  /** 屏幕高度（设备像素，来自 body.client.screenHeight） */
  screenHeight?: number;
  /** 视口宽度（CSS 像素，来自 body.client.viewportWidth） */
  viewportWidth?: number;
  /** 视口高度（CSS 像素，来自 body.client.viewportHeight） */
  viewportHeight?: number;
  /** navigator.platform（来自 body.client.platform） */
  platform?: string;
}

/** 扩展端实际发送的 client 字段（UA 由服务端另从 header 解析，这里只带精确测量值）。 */
export interface IncomingClient {
  ua?: string;
  platform?: string;
  isMobile?: boolean;
  touch?: boolean;
  screenWidth?: number;
  screenHeight?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

/**
 * 解析 User-Agent 字符串得到浏览器、操作系统、设备形态。
 * 纯函数、无副作用，便于单测。UA 缺失/无法识别时返回 Unknown。
 */
export function parseUserAgent(ua: string | undefined | null): {
  browser: string;
  browserVersion: string;
  os: string;
  deviceType: 'mobile' | 'tablet' | 'desktop';
} {
  const s = (ua || '').trim();
  if (!s) {
    return { browser: 'Unknown', browserVersion: '', os: 'Unknown', deviceType: 'desktop' };
  }

  // ── 浏览器 ──
  let browser = 'Unknown';
  let browserVersion = '';
  if (/Edg\//.test(s)) {
    browser = 'Edge';
    browserVersion = (s.match(/Edg\/([\d.]+)/) || [])[1] || '';
  } else if (/OPR\/|Opera/.test(s)) {
    browser = 'Opera';
    browserVersion = (s.match(/(?:OPR|Opera)\/([\d.]+)/) || [])[1] || '';
  } else if (/Firefox\//.test(s) && !/Seamonkey\//.test(s)) {
    browser = 'Firefox';
    browserVersion = (s.match(/Firefox\/([\d.]+)/) || [])[1] || '';
  } else if (/Chrome\//.test(s)) {
    browser = 'Chrome';
    browserVersion = (s.match(/Chrome\/([\d.]+)/) || [])[1] || '';
  } else if (/Safari\//.test(s)) {
    browser = 'Safari';
    // Safari 版本在 Version/ 里
    browserVersion = (s.match(/Version\/([\d.]+)/) || [])[1] || '';
  }

  // ── 操作系统 ──
  let os = 'Unknown';
  if (/Windows NT/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';

  // ── 设备形态 ──
  let deviceType: 'mobile' | 'tablet' | 'desktop' = 'desktop';
  if (/iPhone|iPod|IEMobile|BlackBerry|Mobi|Android.*Mobile/.test(s)) {
    deviceType = 'mobile';
  } else if (/iPad|Tablet|PlayBook|Kindle|Silk|Android(?!.*Mobile)/.test(s)) {
    // iPadOS 13+ 伪装成 Mac + 触屏，这里按 tablet 处理；
    // 纯 Android 平板（UA 不含 Mobile）也归为 tablet。
    deviceType = 'tablet';
  }

  return { browser, browserVersion, os, deviceType };
}

/**
 * 合并「扩展端带来的精确 client」与「UA header 推导」得到完整 ClientInfo。
 *
 * 优先级：
 *  - ua / platform / isMobile / touch / 屏幕尺寸：优先用 body.client，缺失则从 UA 推导。
 *  - browser / os / deviceType：由 UA（body.client.ua 或 userAgentHeader）推导，单一真源。
 */
export function extractClientInfo(input: {
  client?: IncomingClient | null;
  userAgentHeader?: string | null;
}): ClientInfo {
  const bodyClient = input.client || {};
  const ua = bodyClient.ua || input.userAgentHeader || undefined;
  const parsed = parseUserAgent(ua);

  const isMobile =
    typeof bodyClient.isMobile === 'boolean'
      ? bodyClient.isMobile
      : parsed.deviceType === 'mobile';

  // 屏幕尺寸：优先 body.client 真实测量值；否则无（UA 拿不到物理像素）。
  const hasScreen =
    typeof bodyClient.screenWidth === 'number' &&
    typeof bodyClient.screenHeight === 'number';

  const info: ClientInfo = {
    ua,
    browser: parsed.browser,
    browserVersion: parsed.browserVersion,
    os: parsed.os,
    deviceType: parsed.deviceType,
    isMobile,
    touch: typeof bodyClient.touch === 'boolean' ? bodyClient.touch : undefined,
  };
  if (bodyClient.platform) info.platform = bodyClient.platform;
  if (hasScreen) {
    info.screenWidth = bodyClient.screenWidth;
    info.screenHeight = bodyClient.screenHeight;
  }
  if (
    typeof bodyClient.viewportWidth === 'number' &&
    typeof bodyClient.viewportHeight === 'number'
  ) {
    info.viewportWidth = bodyClient.viewportWidth;
    info.viewportHeight = bodyClient.viewportHeight;
  }
  return info;
}

/**
 * 把 ClientInfo 压成一行紧凑、可直接贴进日志的字符串。
 * 例：
 *   Firefox/115.0 (Android, mobile) sw=412 sh=915 vw=412 vh=915
 *   Chrome/120.0 (macOS, desktop)
 *   Unknown/ (Unknown, desktop)  ← UA 缺失时
 */
export function formatClientLabel(info: ClientInfo): string {
  const browser = info.browser || 'Unknown';
  const version = info.browserVersion ? `/${info.browserVersion}` : '';
  const os = info.os || 'Unknown';
  const dt = info.deviceType || 'desktop';
  const mobileTag = info.isMobile ? ', mobile' : '';
  const touchTag =
    typeof info.touch === 'boolean' ? `, ${info.touch ? 'touch' : 'no-touch'}` : '';
  const base = `${browser}${version} (${os}, ${dt}${mobileTag}${touchTag})`;

  const dims: string[] = [];
  if (typeof info.screenWidth === 'number' && typeof info.screenHeight === 'number') {
    dims.push(`sw=${info.screenWidth} sh=${info.screenHeight}`);
  }
  if (typeof info.viewportWidth === 'number' && typeof info.viewportHeight === 'number') {
    dims.push(`vw=${info.viewportWidth} vh=${info.viewportHeight}`);
  }
  if (info.platform) dims.push(`plat=${info.platform}`);

  return dims.length ? `${base} ${dims.join(' ')}` : base;
}
