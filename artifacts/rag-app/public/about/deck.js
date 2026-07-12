(() => {
  const slides = [...document.querySelectorAll(".slide")];
  const body = document.body;
  const progress = document.getElementById("progressBar");
  const counter = document.getElementById("counter");
  const prevButton = document.getElementById("prev");
  const nextButton = document.getElementById("next");
  const overviewButton = document.getElementById("overview");
  const overviewPanel = document.getElementById("overviewPanel");
  const overviewGrid = document.getElementById("overviewGrid");
  const notesButton = document.getElementById("notes");
  const storyMode = matchMedia("(max-width: 700px) and (orientation: portrait)");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let current = Math.max(0, Math.min(slides.length - 1, Number(location.hash.slice(1)) - 1 || 0));
  let wheelLock = false;
  let touchStart = null;
  let revealTimers = [];

  const fragments = (slide = slides[current]) => [...slide.querySelectorAll(".fragment")];

  function clearRevealTimers() {
    revealTimers.forEach((timer) => window.clearTimeout(timer));
    revealTimers = [];
  }

  function revealSlide(slide) {
    clearRevealTimers();
    const items = fragments(slide);
    if (storyMode.matches || reducedMotion.matches) {
      items.forEach((fragment) => fragment.classList.add("visible"));
      return;
    }
    items.forEach((fragment, index) => {
      const timer = window.setTimeout(() => {
        if (slides[current] === slide) fragment.classList.add("visible");
      }, 140 + index * 115);
      revealTimers.push(timer);
    });
  }

  function updateChrome() {
    const number = String(current + 1).padStart(2, "0");
    const total = String(slides.length).padStart(2, "0");
    if (counter) counter.textContent = `${number} / ${total}`;
    if (progress) progress.style.width = `${((current + 1) / slides.length) * 100}%`;
    if (prevButton) prevButton.disabled = current === 0;
    if (nextButton) nextButton.disabled = current === slides.length - 1;
  }

  function showSlide(index) {
    clearRevealTimers();
    const next = Math.max(0, Math.min(slides.length - 1, index));
    const story = storyMode.matches;
    slides.forEach((slide, slideIndex) => {
      slide.classList.toggle("active", slideIndex === next);
      slide.classList.toggle("exit-left", slideIndex < next);
      slide.setAttribute("aria-hidden", story || slideIndex === next ? "false" : "true");
      slide.querySelectorAll("a, button, input").forEach((control) => {
        if (story || slideIndex === next) control.removeAttribute("tabindex");
        else control.setAttribute("tabindex", "-1");
      });
    });
    current = next;
    fragments().forEach((fragment) => fragment.classList.remove("visible"));
    history.replaceState(null, "", `#${String(current + 1).padStart(2, "0")}`);
    updateChrome();
    revealSlide(slides[current]);
  }

  function forward() {
    if (body.classList.contains("overview")) return;
    if (current < slides.length - 1) showSlide(current + 1);
  }

  function backward() {
    if (body.classList.contains("overview")) return;
    if (current > 0) showSlide(current - 1);
  }

  function toggleOverview(force) {
    const enabled = typeof force === "boolean" ? force : !body.classList.contains("overview");
    body.classList.toggle("overview", enabled);
    overviewButton?.setAttribute("aria-pressed", String(enabled));
    overviewPanel.setAttribute("aria-hidden", String(!enabled));
    overviewGrid.querySelectorAll("button").forEach((button, index) => button.setAttribute("aria-current", String(index === current)));
    if (!enabled) showSlide(current);
  }

  function toggleNotes() {
    const enabled = body.classList.toggle("show-notes");
    notesButton?.setAttribute("aria-pressed", String(enabled));
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  prevButton?.addEventListener("click", backward);
  nextButton?.addEventListener("click", forward);
  overviewButton?.addEventListener("click", () => toggleOverview());
  notesButton?.addEventListener("click", toggleNotes);

  slides.forEach((slide, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<span>${String(index + 1).padStart(2, "0")}</span><strong>${slide.dataset.title}</strong>`;
    button.addEventListener("click", () => {
      current = index;
      toggleOverview(false);
    });
    overviewGrid.appendChild(button);
  });

  document.addEventListener("keydown", (event) => {
    const editing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
    if (editing && event.key !== "Escape") return;
    if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(event.key)) {
      event.preventDefault();
      forward();
    } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(event.key)) {
      event.preventDefault();
      backward();
    } else if (event.key.toLowerCase() === "o") {
      event.preventDefault();
      toggleOverview();
    } else if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      toggleNotes();
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      toggleFullscreen();
    } else if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      window.print();
    } else if (event.key === "Escape" && body.classList.contains("overview")) {
      toggleOverview(false);
    }
  });

  document.addEventListener("wheel", (event) => {
    if (body.classList.contains("overview") || wheelLock || Math.abs(event.deltaY) < 28) return;
    wheelLock = true;
    event.deltaY > 0 ? forward() : backward();
    window.setTimeout(() => { wheelLock = false; }, 620);
  }, { passive: true });

  document.addEventListener("touchstart", (event) => {
    const touch = event.changedTouches[0];
    touchStart = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });

  document.addEventListener("touchend", (event) => {
    if (!touchStart || body.classList.contains("overview")) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStart.x;
    const dy = touch.clientY - touchStart.y;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) dx < 0 ? forward() : backward();
    touchStart = null;
  }, { passive: true });

  document.addEventListener("pointermove", (event) => {
    const x = (event.clientX / innerWidth - 0.5) * 2;
    const y = (event.clientY / innerHeight - 0.5) * 2;
    document.documentElement.style.setProperty("--mx", x.toFixed(3));
    document.documentElement.style.setProperty("--my", y.toFixed(3));
  }, { passive: true });

  const canvas = document.getElementById("atmosphere");
  const context = canvas.getContext("2d");
  function paintAtmosphere() {
    const scale = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.floor(innerWidth * scale);
    canvas.height = Math.floor(innerHeight * scale);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const seed = 47;
    for (let i = 0; i < 90; i += 1) {
      const x = ((i * 73 + seed) % 997) / 997 * canvas.width;
      const y = ((i * 151 + seed * 3) % 991) / 991 * canvas.height;
      const radius = ((i * 17) % 4 + 1) * scale * 0.35;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fillStyle = `rgba(135, 183, 255, ${0.08 + (i % 5) * 0.025})`;
      context.fill();
    }
  }
  addEventListener("resize", paintAtmosphere);
  storyMode.addEventListener?.("change", () => showSlide(current));
  reducedMotion.addEventListener?.("change", () => showSlide(current));
  paintAtmosphere();
  showSlide(current);
  requestAnimationFrame(() => body.classList.add("ready"));
})();
