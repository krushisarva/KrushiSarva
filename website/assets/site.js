// KrushiSarva website behaviour. Plain JavaScript, no build step.
// Animation uses GSAP + ScrollTrigger from assets/vendor when they loaded and
// the visitor has not asked for reduced motion; without them every element
// simply stays visible.
(function () {
  var root = document.documentElement;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var gsap = window.gsap;
  var ScrollTrigger = window.ScrollTrigger;
  var animate = !!(gsap && ScrollTrigger) && !reduce;
  var finePointer = window.matchMedia("(pointer: fine)").matches;
  var paused = false;
  var intro = null; // the hero entrance timeline
  var loops = []; // tweens that repeat forever (floating chips)

  // ── Mobile menu ─────────────────────────────────────────────────
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  if (toggle && nav) {
    var setOpen = function (open) {
      nav.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
    };
    toggle.addEventListener("click", function () {
      setOpen(!nav.classList.contains("open"));
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("click", function (e) {
      if (!nav.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("open")) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  // ── Pause animations button: anything that moves on its own can be stopped ──
  var motionBtn = document.querySelector(".motion-toggle");
  function setPaused(on) {
    paused = on;
    root.classList.toggle("paused", on); // freezes the CSS animations
    if (motionBtn) {
      var label = on ? "Play animations" : "Pause animations";
      motionBtn.setAttribute("aria-pressed", String(on));
      motionBtn.title = label;
      motionBtn.querySelector(".sr-only").textContent = label;
    }
    if (on && gsap) {
      // Finish what is mid-way and show everything still waiting to animate
      // in, so pausing never leaves content hidden.
      if (intro) intro.progress(1);
      gsap.set("[data-reveal], [data-goal]", { clearProps: "opacity,transform" });
    }
    loops.forEach(function (t) {
      if (on) t.pause();
      else t.resume();
    });
    try {
      localStorage.setItem("ks-motion-paused", on ? "1" : "0");
    } catch (e) {
      /* storage blocked */
    }
  }
  if (motionBtn) {
    motionBtn.addEventListener("click", function () {
      setPaused(!paused);
    });
  }
  var startPaused = false;
  try {
    startPaused = localStorage.getItem("ks-motion-paused") === "1";
  } catch (e) {
    /* storage blocked */
  }

  // ── Header state + scroll progress ──────────────────────────────
  var header = document.querySelector(".site-header");
  var bar = document.querySelector(".progress span");
  var ticking = false;
  function onScroll() {
    ticking = false;
    var y = window.scrollY;
    if (header) header.classList.toggle("scrolled", y > 40);
    if (bar) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.setProperty("--p", max > 0 ? (y / max).toFixed(4) : 0);
    }
  }
  window.addEventListener(
    "scroll",
    function () {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(onScroll);
      }
    },
    { passive: true },
  );
  onScroll();

  // ── Spotlight that follows the pointer on product cards ─────────
  document.querySelectorAll("[data-spot]").forEach(function (card) {
    card.addEventListener("pointermove", function (e) {
      var r = card.getBoundingClientRect();
      card.style.setProperty("--mx", e.clientX - r.left + "px");
      card.style.setProperty("--my", e.clientY - r.top + "px");
    });
  });

  // ── Rotating language word ("Ask it in हिंदी / मराठी / …") ───────
  var rotWord = document.querySelector(".rotator-word");
  if (rotWord && !reduce) {
    var words = [
      ["hi", "हिंदी"],
      ["mr", "मराठी"],
      ["en", "English"],
      ["ta", "தமிழ்"],
      ["kn", "ಕನ್ನಡ"],
      ["te", "తెలుగు"],
      ["bn", "বাংলা"],
      ["gu", "ગુજરાતી"],
      ["pa", "ਪੰਜਾਬੀ"],
      ["ml", "മലയാളം"],
    ];
    var wi = 0;
    var swap = function () {
      wi = (wi + 1) % words.length;
      rotWord.textContent = words[wi][1];
      rotWord.setAttribute("lang", words[wi][0]);
    };
    setInterval(function () {
      if (document.hidden || paused) return;
      if (gsap) {
        gsap.to(rotWord, {
          yPercent: -60,
          opacity: 0,
          duration: 0.35,
          ease: "power2.in",
          onComplete: function () {
            swap();
            gsap.fromTo(
              rotWord,
              { yPercent: 60, opacity: 0 },
              { yPercent: 0, opacity: 1, duration: 0.5, ease: "power3.out" },
            );
          },
        });
      } else {
        swap();
      }
    }, 2200);
  }

  // ── User guide: section tabs + search ───────────────────────────
  initGuide();

  if (!animate) {
    root.classList.remove("anim");
    if (startPaused) setPaused(true);
    return;
  }
  gsap.registerPlugin(ScrollTrigger);

  // ── Hero intro ──────────────────────────────────────────────────
  var title = document.querySelector("[data-split]");
  if (title) splitWords(title);
  root.classList.remove("anim");

  intro = gsap.timeline({ defaults: { ease: "power4.out" } });
  if (title)
    intro.from(
      title.querySelectorAll(".w > span"),
      { yPercent: 115, duration: 1.1, stagger: 0.07 },
      0,
    );
  intro.from(
    "[data-hero]",
    { y: 28, opacity: 0, duration: 0.9, stagger: 0.12 },
    0.25,
  );
  intro.from(
    "[data-hero-media]",
    { y: 50, scale: 0.94, opacity: 0, duration: 1.3 },
    0.15,
  );
  intro.from(
    ".chip",
    {
      scale: 0.6,
      opacity: 0,
      duration: 0.8,
      stagger: 0.15,
      ease: "back.out(1.7)",
    },
    0.8,
  );

  // Count the hero numbers up from zero.
  document.querySelectorAll("[data-count]").forEach(function (el) {
    var end = Number(el.getAttribute("data-count"));
    var obj = { v: 0 };
    intro.to(
      obj,
      {
        v: end,
        duration: 1.6,
        ease: "power2.out",
        onUpdate: function () {
          el.textContent = String(Math.round(obj.v));
        },
      },
      0.6,
    );
  });

  // Chips bob gently once they are in.
  document.querySelectorAll("[data-float]").forEach(function (chip, i) {
    loops.push(
      gsap.to(chip, {
        y: -12,
        duration: 2.4 + i * 0.5,
        ease: "sine.inOut",
        yoyo: true,
        repeat: -1,
        delay: 1.6 + i * 0.3,
      }),
    );
  });

  // Hero photo tilts toward the pointer.
  var media = document.querySelector("[data-hero-media]");
  var frame = document.querySelector(".hero-frame");
  if (media && frame && finePointer) {
    var rx = gsap.quickTo(frame, "rotationX", {
      duration: 0.8,
      ease: "power3.out",
    });
    var ry = gsap.quickTo(frame, "rotationY", {
      duration: 0.8,
      ease: "power3.out",
    });
    var hero = document.querySelector(".hero");
    hero.addEventListener("pointermove", function (e) {
      var r = hero.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5;
      var py = (e.clientY - r.top) / r.height - 0.5;
      ry(px * 10);
      rx(-py * 8);
    });
    hero.addEventListener("pointerleave", function () {
      rx(0);
      ry(0);
    });
  }

  // Hero photo drifts slower than the page as it scrolls away.
  if (frame) {
    gsap.to(".hero-frame img", {
      yPercent: 10,
      ease: "none",
      scrollTrigger: {
        trigger: ".hero",
        start: "top top",
        end: "bottom top",
        scrub: true,
      },
    });
  }

  // ── Reveal on scroll ────────────────────────────────────────────
  gsap.set("[data-reveal]", { y: 46, opacity: 0 });
  ScrollTrigger.batch("[data-reveal]", {
    start: "top 88%",
    once: true,
    onEnter: function (batch) {
      // clearProps hands transform back to the stylesheet, so the CSS hover lift works again.
      gsap.to(batch, {
        y: 0,
        opacity: 1,
        duration: 1,
        ease: "power3.out",
        stagger: 0.1,
        overwrite: true,
        clearProps: "transform,opacity",
      });
    },
  });

  // ── Goals: the line fills as you scroll, each goal lights up ────
  var line = document.querySelector(".goals-line span");
  if (line) {
    line.style.setProperty("--g", 0);
    ScrollTrigger.create({
      trigger: ".goals",
      start: "top 70%",
      end: "bottom 60%",
      scrub: true,
      onUpdate: function (self) {
        line.style.setProperty("--g", self.progress.toFixed(3));
      },
    });
    gsap.set("[data-goal]", { opacity: 0, x: 40 });
    document.querySelectorAll("[data-goal]").forEach(function (li) {
      ScrollTrigger.create({
        trigger: li,
        start: "top 75%",
        onEnter: function () {
          li.classList.add("on");
          gsap.to(li, {
            opacity: 1,
            x: 0,
            duration: 0.9,
            ease: "power3.out",
            clearProps: "transform,opacity",
          });
        },
      });
    });
  }

  // Images inside cards and pillars settle in with a small zoom.
  gsap.utils.toArray(".pillar-art img, .goals-img").forEach(function (img) {
    gsap.from(img, {
      scale: 1.12,
      duration: 1.4,
      ease: "power3.out",
      clearProps: "transform",
      scrollTrigger: { trigger: img, start: "top 90%", once: true },
    });
  });

  // Fonts and lazy images change layout; recompute trigger positions after.
  window.addEventListener("load", function () {
    ScrollTrigger.refresh();
  });
  if (startPaused) setPaused(true);

  // ── Helpers ─────────────────────────────────────────────────────
  // Wrap each word of an element (keeping inner tags like <em>) in
  // <span class="w"><span>word</span></span> so it can rise into view.
  function splitWords(el) {
    var walk = function (node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 3) {
          var frag = document.createDocumentFragment();
          child.textContent.split(/(\s+)/).forEach(function (part) {
            if (!part) return;
            if (/^\s+$/.test(part)) {
              frag.appendChild(document.createTextNode(" "));
              return;
            }
            var outer = document.createElement("span");
            outer.className = "w";
            var inner = document.createElement("span");
            inner.textContent = part;
            outer.appendChild(inner);
            frag.appendChild(outer);
          });
          node.replaceChild(frag, child);
        } else if (child.nodeType === 1) {
          walk(child);
        }
      });
    };
    el.setAttribute("aria-label", el.textContent.replace(/\s+/g, " ").trim());
    walk(el);
    el.classList.add("split");
  }

  function initGuide() {
    var tabs = document.querySelector(".tabs");
    var sections = Array.prototype.slice.call(
      document.querySelectorAll(".guide"),
    );
    if (!tabs || !sections.length) return;
    var links = Array.prototype.slice.call(tabs.querySelectorAll("a"));
    var ink = tabs.querySelector(".tabs-ink");

    var setActive = function (id) {
      links.forEach(function (a) {
        var on = a.getAttribute("href") === "#" + id;
        a.classList.toggle("active", on);
        if (on) {
          a.setAttribute("aria-current", "true");
          if (ink) {
            ink.style.width = a.offsetWidth + "px";
            ink.style.transform = "translateX(" + a.offsetLeft + "px)";
          }
        } else {
          a.removeAttribute("aria-current");
        }
      });
    };
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) setActive(en.target.id);
        });
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    sections.forEach(function (s) {
      io.observe(s);
    });
    setActive((location.hash || "#" + sections[0].id).slice(1));
    window.addEventListener("resize", function () {
      var a = tabs.querySelector("a.active");
      if (a) setActive(a.getAttribute("href").slice(1));
    });

    // Search: show only tasks whose text matches every word typed.
    var input = document.getElementById("guide-search");
    var empty = document.querySelector(".no-results");
    if (!input) return;
    input.addEventListener("input", function () {
      var terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      var shown = 0;
      sections.forEach(function (sec) {
        var count = 0;
        sec.querySelectorAll(".task").forEach(function (task) {
          var hit = terms.every(function (t) {
            return task.textContent.toLowerCase().indexOf(t) !== -1;
          });
          task.hidden = !hit;
          if (hit) count++;
        });
        sec.hidden = count === 0;
        shown += count;
      });
      if (empty) empty.classList.toggle("show", shown === 0);
      // Screen readers hear the count; the visible message covers no matches.
      var status = document.getElementById("search-status");
      if (status) {
        status.textContent = !terms.length
          ? ""
          : shown === 1
            ? "1 task matches"
            : shown + " tasks match";
      }
      if (window.ScrollTrigger) window.ScrollTrigger.refresh();
    });
  }
})();
