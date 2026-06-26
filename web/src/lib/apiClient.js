export async function requestJson(url, options = {}) {
  const method = options.method || "GET";
  if (typeof window.fetch === "function") {
    const res = await window.fetch(url, options);
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      const preview = text.replace(/\s+/g, " ").slice(0, 120);
      throw new Error(`服务返回了非 JSON 响应，可能是请求超时或网关错误：${preview || `HTTP ${res.status}`}`);
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  if (typeof window.XMLHttpRequest === "function") {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      const headers = options.headers || {};
      Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
      xhr.onload = () => {
        let data = {};
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        } catch (error) {
          reject(new Error(`响应解析失败：${error.message}`));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(data.error || `HTTP ${xhr.status}`));
          return;
        }
        resolve(data);
      };
      xhr.onerror = () => reject(new Error("网络请求失败"));
      xhr.send(options.body || null);
    });
  }

  return requestJsonp(url, options);
}

export function requestJsonp(url, options = {}) {
  const method = options.method || "GET";
  return new Promise((resolve, reject) => {
    const callbackName = `__aiAdminJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const requestUrl = new URL(url, window.location.origin);
    const timer = window.setTimeout(() => {
      delete window[callbackName];
      script.remove();
      reject(new Error("本机服务响应超时"));
    }, Number(options.timeoutMs || 10000));

    requestUrl.searchParams.set("_jsonp", callbackName);
    if (method !== "GET") requestUrl.searchParams.set("_method", method);
    if (options.body) requestUrl.searchParams.set("_body", options.body);

    window[callbackName] = (payload) => {
      window.clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      if (payload?.ok === false || payload?.error) {
        reject(new Error(payload.error || payload.message || "请求失败"));
        return;
      }
      resolve(payload);
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      reject(new Error("网络请求失败"));
    };
    script.src = requestUrl.toString();
    document.head.appendChild(script);
  });
}
