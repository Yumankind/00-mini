/**
 * The bootstrap page — everything this origin is, in one document.
 *
 * WHY A PAGE AT ALL, AND NOT JUST A SERVICE WORKER. A service worker cannot be installed by anyone
 * but a page on its own origin, and it cannot be given data by anyone but a client of that origin.
 * The app lives on a DIFFERENT origin: all it can do is frame this page and `postMessage` it. So this
 * page is the whole of the border post — it registers the worker, it takes the files the app posts
 * and writes them into THIS origin's Cache Storage, it relays the worker's virtual-port questions
 * back to the app, and it relays the served page's picks up to the app. Nothing here is stored, and
 * every cache it opens is deleted when the tab goes away.
 *
 * WHY THE APP'S ORIGIN COMES IN THE HASH. A `postMessage` needs a target origin or it needs `"*"`,
 * and `"*"` on the message that hands over the control PORT would let any page that framed this one
 * drive the preview. So the app puts its own origin in the fragment (`#o=…`, which never leaves the
 * browser and is never sent to the Worker) and this page targets exactly that, once. Everything after
 * the handshake travels on the `MessagePort`, which no third party can obtain a reference to.
 *
 * Authored as a `String.raw`: no backtick and no `${` may appear in the source below.
 */
export const BOOTSTRAP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>00 preview host</title>
<style>
  html, body { margin: 0; height: 100%; background: #fff; }
  #view { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
  #say {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    padding: 24px; text-align: center; color: #667; background: #fff;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
</style>
</head>
<body>
<div id="say">Preview host starting…</div>
<iframe id="view" title="Preview" hidden></iframe>
<script>
"use strict";
(function () {
  var V = 1;
  var CACHE_PREFIX = "00-preview-";
  var view = document.getElementById("view");
  var say = document.getElementById("say");
  var control = null;
  var siteId = null;
  var pending = new Map();
  var nextId = 1;

  function tell(text) {
    say.textContent = text;
    say.hidden = false;
    view.hidden = true;
  }

  function show(url) {
    say.hidden = true;
    view.hidden = false;
    view.src = url;
  }

  function appOrigin() {
    var match = /(?:^|[#&])o=([^&]+)/.exec(location.hash || "");
    if (!match) return null;
    try {
      return new URL(decodeURIComponent(match[1])).origin;
    } catch (err) {
      return null;
    }
  }

  function send(message) {
    if (control) control.postMessage(message);
  }

  async function wipe() {
    var names = await caches.keys();
    await Promise.all(
      names.filter(function (n) { return n.indexOf(CACHE_PREFIX) === 0; }).map(function (n) { return caches.delete(n); })
    );
  }

  async function putFile(id, file) {
    var cache = await caches.open(CACHE_PREFIX + id);
    var key = "/s/" + id + "/" + String(file.site).split("/").map(encodeURIComponent).join("/");
    var headers = { "content-type": file.mime || "application/octet-stream", "cache-control": "no-store" };
    if (file.source) headers["x-00-source"] = file.source;
    await cache.put(new Request(new URL(key, location.origin).toString()), new Response(file.bytes, { headers: headers }));
  }

  async function dropFile(id, site) {
    var cache = await caches.open(CACHE_PREFIX + id);
    var key = "/s/" + id + "/" + String(site).split("/").map(encodeURIComponent).join("/");
    await cache.delete(new Request(new URL(key, location.origin).toString()));
  }

  async function onControl(message) {
    if (!message || message.v !== V) return;
    if (message.kind === "00-preview-files") {
      await wipe();
      siteId = message.siteId;
      for (var i = 0; i < message.files.length; i++) await putFile(siteId, message.files[i]);
      send({ kind: "00-preview-stored", v: V, siteId: siteId, count: message.files.length });
      if (message.entry) show("/s/" + siteId + "/" + String(message.entry).split("/").map(encodeURIComponent).join("/"));
      return;
    }
    if (message.kind === "00-preview-file") {
      if (!siteId) return;
      if (message.file.bytes === null) await dropFile(siteId, message.file.site);
      else await putFile(siteId, message.file);
      send({ kind: "00-preview-stored", v: V, siteId: siteId, count: 1 });
      return;
    }
    if (message.kind === "00-preview-navigate") {
      show(message.url);
      return;
    }
    if (message.kind === "00-inspect") {
      if (view.contentWindow) view.contentWindow.postMessage({ kind: "00-inspect", v: V, on: !!message.on }, location.origin);
      return;
    }
    if (message.kind === "00-preview-port-response") {
      var reply = pending.get(message.id);
      pending.delete(message.id);
      if (reply) {
        reply.postMessage(message.answer);
        reply.close();
      }
      return;
    }
  }

  // The worker asks the app to serve a virtual port; this page is the only thing that can carry the
  // question across the origin boundary. The MessagePort the worker sent is held until the answer
  // comes back, and the worker's own 10 s timeout is the end of the story if it never does.
  function onWorkerMessage(event) {
    var data = event.data;
    if (!data || data.kind !== "00-preview-port-request") return;
    var id = nextId++;
    pending.set(id, event.ports[0]);
    send({ kind: "00-preview-port-request", v: V, id: id, port: data.port, request: data.request });
  }

  // The served page talks to its own parent, which is this page: same origin, so the only check that
  // matters is that it really is the frame we put there.
  function onFrameMessage(event) {
    if (event.source !== view.contentWindow) return;
    var data = event.data;
    if (!data || typeof data.kind !== "string") return;
    if (data.kind === "00-pick" || data.kind === "00-pick-clear" || data.kind === "00-nav") send(data);
  }

  async function start() {
    var origin = appOrigin();
    if (!origin) {
      tell("This page is the 00 preview host. It is opened by the 00 app in a frame and holds nothing on its own.");
      return;
    }
    if (!("serviceWorker" in navigator)) {
      tell("This browser has no service worker here, so a live preview cannot be served.");
      return;
    }
    try {
      await navigator.serviceWorker.register("/preview-sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
    } catch (err) {
      tell("The preview worker could not be registered: " + (err && err.message ? err.message : String(err)));
      window.parent.postMessage({ kind: "00-preview-error", v: V, message: String(err) }, origin);
      return;
    }
    navigator.serviceWorker.addEventListener("message", onWorkerMessage);
    window.addEventListener("message", onFrameMessage);
    window.addEventListener("pagehide", function () { void wipe(); });

    var channel = new MessageChannel();
    control = channel.port1;
    control.onmessage = function (event) { void onControl(event.data); };
    control.start();
    tell("Ready — waiting for the app to post a folder.");
    window.parent.postMessage({ kind: "00-preview-ready", v: V }, origin, [channel.port2]);
  }

  void start();
})();
</script>
</body>
</html>
`;
