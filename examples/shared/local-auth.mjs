const cookieName = "webdr_token";
const maxLoginBytes = 2048;
const noCache = { "cache-control": "no-store" };

const signInPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Viewherd · Sign in</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center;
        background: #f5f3ed; color: #242720; font: 16px system-ui, sans-serif; }
      form { width: min(340px, 80vw); }
      h1 { font-size: 30px; letter-spacing: -.04em; }
      p { color: #61675d; line-height: 1.5; }
      label { display: block; margin-top: 24px; }
      input, button { box-sizing: border-box; width: 100%; padding: 14px;
        margin-top: 8px; border: 1px solid #b5baae; border-radius: 8px; font: inherit; }
      button { margin-top: 16px; background: #303d2b; color: white; cursor: pointer; }
    </style>
  </head>
  <body>
    <form method="post" action="/api/auth">
      <h1>Open your studio.</h1>
      <p>Enter this server's access token to continue.</p>
      <label for="token">Access token</label>
      <input id="token" type="password" name="token" autocomplete="current-password" required>
      <button>Open studio</button>
    </form>
  </body>
</html>`;

function errorResponse(message, status, headers = {}) {
  return Response.json(
    { error: message },
    { status, headers: { ...noCache, ...headers } },
  );
}

async function readLogin(request) {
  if (Number(request.headers.get("content-length")) > maxLoginBytes) {
    throw Object.assign(new Error("Keep the login request under 2 KB."), {
      status: 413,
    });
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxLoginBytes) {
        await reader.cancel();
        throw Object.assign(new Error("Keep the login request under 2 KB."), {
          status: 413,
        });
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Optional token protection for a single-user localhost example. */
export function createLocalAuth({ token } = {}) {
  if (token !== undefined && typeof token !== "string") {
    throw new TypeError("The local access token must be a string.");
  }
  function authorize(request) {
    const authenticated =
      !token ||
      request.headers.get("authorization") === `Bearer ${token}` ||
      request.headers
        .get("cookie")
        ?.split(";")
        .some(
          (part) =>
            part.trim() === `${cookieName}=${encodeURIComponent(token)}`,
        );
    if (!authenticated) return null;
    return {
      id: "local-user",
      name: "Studio user",
      actor: "human/ui",
      roles: ["owner"],
    };
  }

  async function handleLogin(request) {
    if (!token) return null;
    const url = new URL(request.url);
    if (
      url.pathname === "/" &&
      request.method === "GET" &&
      !authorize(request)
    ) {
      return new Response(signInPage, {
        headers: {
          ...noCache,
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        },
      });
    }
    if (url.pathname !== "/api/auth") return null;
    if (request.method !== "POST")
      return errorResponse("Use POST to sign in.", 405, { allow: "POST" });
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin)
      return errorResponse("Use the same origin to sign in.", 403);
    try {
      const body = await readLogin(request);
      if (new URLSearchParams(body).get("token") !== token)
        return errorResponse("The access token did not match.", 401);
      return new Response(null, {
        status: 303,
        headers: {
          ...noCache,
          location: "/",
          "set-cookie": `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${url.protocol === "https:" ? "; Secure" : ""}`,
        },
      });
    } catch (error) {
      return errorResponse(
        error.status ? error.message : "Send a valid login form.",
        error.status ?? 400,
      );
    }
  }

  return { authorize, handleLogin };
}
