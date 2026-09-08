import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

/**
 * В разработке service worker только мешает: он мог остаться с прежней сборки
 * и продолжает отдавать файлы, которых уже нет, — экран остаётся пустым.
 * Снимаем его и чистим кэш до отрисовки, чтобы такое не повторялось.
 */
if (import.meta.env.DEV && "serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then(async (регистрации) => {
    if (регистрации.length === 0) return;
    await Promise.all(регистрации.map((р) => р.unregister()));
    if ("caches" in window) {
      const имена = await caches.keys();
      await Promise.all(имена.map((и) => caches.delete(и)));
    }
    location.reload();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
