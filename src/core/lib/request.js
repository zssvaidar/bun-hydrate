module.exports = function createFetchRequest(host, protocol, req) {
    let origin = `${protocol}://${host}`;
    let url = new URL(req.url, origin);

    let controller = new AbortController();

    let headers = new Headers();

    for (let [key, value] of req.headers) {
      headers.append(key, value);
    }

    let init = {
      method: req.method,
      headers,
      signal: controller.signal,
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body;
      init.duplex = "half";
    }

    return new Request(url.href, init);
  };
