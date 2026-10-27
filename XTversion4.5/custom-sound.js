(() => {
  "use strict";
  const KEY = "xiaotianCustomClaimSoundV1";
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_SECONDS = 30;

  function validateAudio(url) {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      const finish = (error) => {
        clearTimeout(timer);
        audio.onloadedmetadata = audio.onerror = null;
        audio.removeAttribute("src");
        audio.load();
        error ? reject(new Error(error)) : resolve();
      };
      const timer = setTimeout(() => finish("音频读取超时，请换一个文件"), 8000);
      audio.onloadedmetadata = () => finish(
        !Number.isFinite(audio.duration) || audio.duration <= 0 || audio.duration > MAX_SECONDS
          ? "请选择时长不超过 30 秒的音频" : "",
      );
      audio.onerror = () => finish("无法播放这个文件，请使用有效的 MP3 或 WAV 音频");
      audio.preload = "metadata";
      audio.src = url;
    });
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("文件读取失败，请重新选择"));
      reader.readAsDataURL(file);
    });
  }

  function normalize(value) {
    if (value == null) return null;
    if (typeof value.data !== "string" || value.data.length > Math.ceil(MAX_BYTES / 3) * 4 + 200
      || !/^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/]+=*$/i.test(value.data)) {
      throw new Error("保存的音频不可用，已使用原始提示音");
    }
    return {name: String(value.name || "自定义提示音").slice(0, 120), data: value.data};
  }

  globalThis.XiaotianCustomSound = Object.freeze({
    mount(panel, navigate) {
      const defaultUrl = chrome.runtime.getURL("qiangdao_tile.mp3");
      const button = document.createElement("button");
      button.type = "button";
      button.id = "sv-sound-settings-open";
      button.textContent = "提示音";
      button.title = "设置领取成功提示音";
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", "sv-sound-settings");
      panel.querySelector(".sv-sound-toggle > span:last-child").replaceWith(button);
      const box = document.createElement("section");
      box.id = "sv-sound-settings";
      box.className = "sv-subpage sv24-sound-page";
      box.hidden = true;
      box.innerHTML = `
        <div class="sv-subpage-header sv24-subpage-header"><strong>提示音设置</strong><button type="button" data-sound="close">返回</button></div>
        <div class="sv-sound-current"></div>
        <label class="sv-sound-file-label">选择音频<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.webm" aria-label="选择自定义提示音"></label>
        <small>不超过 2MB、30 秒，建议使用 MP3 或 WAV。仅保存在本机。</small>
        <div class="sv-sound-actions"><button type="button" data-sound="preview">试听</button><button type="button" data-sound="save" disabled>保存提示音</button><button type="button" data-sound="reset">恢复默认</button></div>
        <div class="sv-sound-notice" role="status" aria-live="polite"></div>`;
      panel.querySelector("#sv-workload-page").after(box);
      const input = box.querySelector("input");
      const save = box.querySelector('[data-sound="save"]');
      const reset = box.querySelector('[data-sound="reset"]');
      const previewButton = box.querySelector('[data-sound="preview"]');
      let current = null, pending = null, preview = null, preload = null;
      let loadEpoch = 0, selectEpoch = 0, writing = false, failed = false;
      const notice = (text) => { box.querySelector(".sv-sound-notice").textContent = text; };
      const label = () => {
        box.querySelector(".sv-sound-current").textContent = `当前：${current && !failed ? current.name : "原始提示音"}`;
      };
      const stopPreview = () => {
        if (preview) { preview.pause(); preview.removeAttribute("src"); preview.load(); preview = null; }
      };
      const controls = () => {
        save.disabled = writing || !pending;
        reset.disabled = input.disabled = writing;
      };
      async function apply(value, epoch) {
        try {
          const next = normalize(value);
          if (next) await validateAudio(next.data);
          if (epoch !== loadEpoch) return;
          current = next;
          failed = false;
          if (preload) { preload.removeAttribute("src"); preload.load(); }
          preload = next ? new Audio(next.data) : null;
          if (preload) preload.preload = "auto";
          label();
        } catch (error) {
          if (epoch !== loadEpoch) return;
          current = null;
          label();
          notice(error.message);
        }
      }
      const onStorage = (changes, area) => {
        if (area === "local" && Object.prototype.hasOwnProperty.call(changes, KEY)) {
          void apply(changes[KEY].newValue, ++loadEpoch);
        }
      };
      chrome.storage.onChanged.addListener(onStorage);
      const initialEpoch = ++loadEpoch;
      void chrome.storage.local.get(KEY).then((data) => {
        if (initialEpoch === loadEpoch) return apply(data[KEY], initialEpoch);
      }).catch(() => notice("无法读取保存的音频，暂时使用原始提示音"));
      label();
      button.addEventListener("click", (event) => {
        event.preventDefault();
        navigate("sound");
      });
      box.querySelector('[data-sound="close"]').addEventListener("click", () => {
        navigate(""); button.focus();
      });
      input.addEventListener("change", async () => {
        const epoch = ++selectEpoch;
        pending = null; controls(); stopPreview();
        const file = input.files[0];
        if (!file) { notice(""); return; }
        try {
          if (!file.size || file.size > MAX_BYTES) throw new Error("请选择大小在 0～2MB 之间的音频文件");
          const mimes = {mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", webm: "audio/webm"};
          const mime = mimes[file.name.split(".").pop().toLowerCase()];
          if (!mime && !file.type.startsWith("audio/")) throw new Error("请选择音频文件");
          notice("正在检查音频…");
          const data = await readFile(file.type.startsWith("audio/") ? file : new Blob([file], {type: mime}));
          await validateAudio(data);
          if (epoch !== selectEpoch) return;
          pending = {name: file.name.slice(0, 120), data};
          notice(`已选择 ${pending.name}，试听后点击保存生效`);
        } catch (error) { if (epoch === selectEpoch) notice(error.message); }
        finally { if (epoch === selectEpoch) controls(); }
      });
      previewButton.addEventListener("click", () => {
        stopPreview();
        preview = new Audio(pending?.data || (failed ? null : current?.data) || defaultUrl);
        const playing = preview;
        playing.play().catch(() => { if (preview === playing) notice("试听失败，请换一个音频或再次点击试听"); });
      });
      save.addEventListener("click", async () => {
        if (!pending || writing) return;
        writing = true; controls();
        const selected = pending;
        try {
          await chrome.storage.local.set({[KEY]: selected});
          await apply(selected, ++loadEpoch);
          pending = null; input.value = ""; stopPreview();
          notice(failed || !current ? "音频未能加载，已使用原始提示音" : "提示音已保存，其他工作页面也会同步使用");
        } catch (error) { notice("保存失败，原设置未更改；请检查本机存储空间后重试"); }
        finally { writing = false; controls(); }
      });
      reset.addEventListener("click", async () => {
        if (writing) return;
        writing = true; ++selectEpoch; controls();
        try {
          await chrome.storage.local.remove(KEY);
          await apply(null, ++loadEpoch);
          pending = null; input.value = ""; stopPreview(); notice("已恢复原始提示音");
        } catch (error) { notice("恢复失败，请重试"); }
        finally { writing = false; controls(); }
      });
      window.addEventListener("pagehide", stopPreview);
      return Object.freeze({
        setVisible(open) {
          box.hidden = !open;
          button.setAttribute("aria-expanded", String(open));
          if (!open) stopPreview();
        },
        getSource: () => (!failed && current?.data) || defaultUrl,
        fallback() { failed = true; label(); notice("自定义音频播放失败，已回退到原始提示音"); },
        stopPreview,
      });
    },
  });
})();
