// Serves product images from the private-by-default S3 bucket under
// media.eyra.org.in. S3 only answers to its own hostname, and Cloudflare's Free
// plan cannot rewrite the Host header, so this small Worker fetches each file
// from the bucket address and hands it back, cached at Cloudflare's edge.
//
// __BUCKET_HOST__ is filled in by Terraform.

const BUCKET_HOST = "__BUCKET_HOST__";

// Never served from here, even if a file in these folders were made public.
const PRIVATE_FOLDERS = ["credit-notes/", "gstr1/", "invoices/"];

const MONTH = 2592000;
const DAY = 86400;

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const key = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
    if (!key || key.includes("..") || PRIVATE_FOLDERS.some((folder) => key.startsWith(folder))) {
      return new Response("Not found", { status: 404 });
    }

    const upstream = await fetch("https://" + BUCKET_HOST + "/" + encodeURI(key), {
      method: request.method,
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { "200-299": MONTH, "404": 60, "403": 60, "500-599": 0 },
      },
    });

    // A private file answers 403 from S3. Show the same "not found" as a missing one.
    if (upstream.status === 403 || upstream.status === 404) {
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
    }
    if (!upstream.ok) {
      return new Response("Unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
    }

    const headers = new Headers();
    for (const name of ["content-type", "content-length", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("Cache-Control", "public, max-age=" + DAY);
    headers.set("X-Content-Type-Options", "nosniff");

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
