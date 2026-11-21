(() => {
	'use strict';

	const DEFAULT_VOCAB_FILE = './vocab_prepared.tsv';
	const TARGET_COUNT = 6;
	const DB_NAME = 'ArabicTrainer';
	const DB_VERSION = 1;

	const ALPHABET_DATA = [
		{ id: 'alif', char: 'ا', name: 'Alif [ʔ, aː]', speak: 'أَلِف' },
		{ id: 'baa', char: 'ب', name: 'Ba [b]', speak: 'بَاء' },
		{ id: 'taa', char: 'ت', name: 'Ta [t]', speak: 'تَاء' },
		{ id: 'thaa', char: 'ث', name: 'Tha [θ]', speak: 'ثَاء' },
		{ id: 'jeem', char: 'ج', name: 'Dschim [d͡ʒ]', speak: 'جِيم' },
		{ id: 'hhaa', char: 'ح', name: 'Ḥa [ħ]', speak: 'حَاء' },
		{ id: 'khaa', char: 'خ', name: 'Cha [x]', speak: 'خَاء' },
		{ id: 'daal', char: 'د', name: 'Dal [d]', speak: 'دَال' },
		{ id: 'dhaal', char: 'ذ', name: 'Dhal [ð]', speak: 'ذَال' },
		{ id: 'raa', char: 'ر', name: 'Ra [r]', speak: 'رَاء' },
		{ id: 'zay', char: 'ز', name: 'Zay [z]', speak: 'زَاي' },
		{ id: 'seen', char: 'س', name: 'Sin [s]', speak: 'سِين' },
		{ id: 'sheen', char: 'ش', name: 'Schin [ʃ]', speak: 'شِين' },
		{ id: 'saad', char: 'ص', name: 'Ṣad [sˤ]', speak: 'صَاد' },
		{ id: 'daad', char: 'ض', name: 'Ḍad [dˤ]', speak: 'ضَاد' },
		{ id: 'ttaa', char: 'ط', name: 'Ṭa [tˤ]', speak: 'طَاء' },
		{ id: 'zhaa', char: 'ظ', name: 'Ẓa [ðˤ]', speak: 'ظَاء' },
		{ id: 'ayn', char: 'ع', name: 'ʿAin [ʕ]', speak: 'عَيْن' },
		{ id: 'ghayn', char: 'غ', name: 'Ghain [ɣ]', speak: 'غَيْن' },
		{ id: 'faa', char: 'ف', name: 'Fa [f]', speak: 'فَاء' },
		{ id: 'qaaf', char: 'ق', name: 'Qaf [q]', speak: 'قَاف' },
		{ id: 'kaaf', char: 'ك', name: 'Kaf [k]', speak: 'كَاف' },
		{ id: 'laam', char: 'ل', name: 'Lam [l]', speak: 'لَام' },
		{ id: 'meem', char: 'م', name: 'Mim [m]', speak: 'مِيم' },
		{ id: 'noon', char: 'ن', name: 'Nun [n]', speak: 'نُون' },
		{ id: 'haa', char: 'ه', name: 'Ha [h]', speak: 'هَاء' },
		{ id: 'waw', char: 'و', name: 'Waw [w, uː]', speak: 'وَاو' },
		{ id: 'yaa', char: 'ي', name: 'Ya [j, iː]', speak: 'يَاء' }
	];

	const state = {
		db: null,
		mode: 'alphabet',
		openDrawer: null,
		meta: {
			theme: 'auto',
			audioMode: 'auto'
		},
		alphaProgress: {},
		alphaPool: [],
		alphaCurrent: null,
		alphaLastId: null,
		alphaRevealed: false,
		vocabTotal: 0,
		vocabUnlocked: [],
		vocabPool: [],
		vocabCurrent: null,
		vocabLastRank: null,
		vocabRevealed: false,
		arabicVoice: null,
		audioPlayer: new Audio(),
		recognition: null
	};

	const $ = (id) => document.getElementById(id);

	function shuffleArray(items) {
		for (let i = items.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[items[i], items[j]] = [items[j], items[i]];
		}
		return items;
	}

	function avoidImmediateRepeat(list, lastKey, getKey) {
		if (list.length > 1 && lastKey !== null && getKey(list[0]) === lastKey) {
			const swapIdx = 1 + Math.floor(Math.random() * (list.length - 1));
			[list[0], list[swapIdx]] = [list[swapIdx], list[0]];
		}
	}

	function setAnswerVisibility(el, visible) {
		el.classList.toggle('is-revealed', visible);
		el.setAttribute('aria-hidden', String(!visible));
		el.inert = !visible;
	}

	function animatePromptEntry(el) {
		el.classList.remove('is-entering');
		void el.offsetWidth;
		el.classList.add('is-entering');
	}

	function escapeHtml(str) {
		return String(str ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function normalizeArabic(text) {
		return String(text || '')
			.replace(/[\u064B-\u065F\u0670\u0640]/g, '')
			.replace(/[أإآٱ]/g, 'ا')
			.replace(/ة/g, 'ه')
			.replace(/ى/g, 'ي')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function isArabicWord(word) {
		return /^[\u0621-\u064A\u064B-\u0652\u0670]+$/.test(word);
	}

	function getCounter(record) {
		if (typeof record.counter === 'number') {
			return Math.max(0, Math.min(TARGET_COUNT, record.counter));
		}
		if (typeof record.phase === 'number' && (record.reviews || 0) > 0) {
			return Math.max(0, Math.min(TARGET_COUNT, record.phase - 1));
		}
		return 0;
	}

	function renderDots(containerEl, count) {
		let html = '';
		for (let i = 0; i < TARGET_COUNT; i++) {
			html += `<span class="dot${i < count ? ' filled' : ''}"></span>`;
		}
		containerEl.innerHTML = html;
		containerEl.title = `${count} von ${TARGET_COUNT} richtig`;
	}

	function showToast(message) {
		const toast = $('toast');
		toast.textContent = message;
		toast.hidden = false;
		clearTimeout(showToast._timer);
		showToast._timer = setTimeout(() => {
			toast.hidden = true;
		}, 2600);
	}

	function splitMeaningAndExample(rawMeaning) {
		const text = String(rawMeaning || '').trim();
		if (!text) return { meaning: '', example: '' };
		const parts = text.split(/\s*\|\s*/);
		if (parts.length >= 2) {
			return {
				meaning: parts[0].trim(),
				example: parts.slice(1).join(' · ').trim()
			};
		}
		return { meaning: text, example: '' };
	}

	/* ==================== INDEXEDDB ==================== */

	function openDatabase() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, DB_VERSION);
			req.onupgradeneeded = (event) => {
				const db = event.target.result;
				if (!db.objectStoreNames.contains('meta')) {
					db.createObjectStore('meta', { keyPath: 'key' });
				}
				if (!db.objectStoreNames.contains('vocab')) {
					const store = db.createObjectStore('vocab', { keyPath: 'rank' });
					store.createIndex('unlocked', 'unlocked', { unique: false });
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	function idbGet(storeName, key) {
		return new Promise((resolve, reject) => {
			const tx = state.db.transaction(storeName, 'readonly');
			const req = tx.objectStore(storeName).get(key);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	function idbPut(storeName, value) {
		return new Promise((resolve, reject) => {
			const tx = state.db.transaction(storeName, 'readwrite');
			tx.objectStore(storeName).put(value);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	function idbClear(storeName) {
		return new Promise((resolve, reject) => {
			const tx = state.db.transaction(storeName, 'readwrite');
			tx.objectStore(storeName).clear();
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	function idbCount(storeName) {
		return new Promise((resolve, reject) => {
			const tx = state.db.transaction(storeName, 'readonly');
			const req = tx.objectStore(storeName).count();
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	function idbGetUnlockedVocab() {
		return new Promise((resolve, reject) => {
			const tx = state.db.transaction('vocab', 'readonly');
			const index = tx.objectStore('vocab').index('unlocked');
			const req = index.getAll(1);
			req.onsuccess = () => resolve(req.result || []);
			req.onerror = () => reject(req.error);
		});
	}

	function idbBulkPutVocab(items, onProgress) {
		return new Promise((resolve, reject) => {
			const chunkSize = 2500;
			let offset = 0;

			function nextChunk() {
				if (offset >= items.length) {
					resolve();
					return;
				}
				const tx = state.db.transaction('vocab', 'readwrite');
				const store = tx.objectStore('vocab');
				const end = Math.min(offset + chunkSize, items.length);
				for (let i = offset; i < end; i++) {
					store.put(items[i]);
				}
				tx.oncomplete = () => {
					offset = end;
					if (onProgress) onProgress(offset, items.length);
					setTimeout(nextChunk, 0);
				};
				tx.onerror = () => reject(tx.error);
			}

			nextChunk();
		});
	}

	async function saveMeta() {
		await idbPut('meta', { key: 'appMeta', value: state.meta });
	}

	async function saveAlphaProgress() {
		await idbPut('meta', { key: 'alphaProgress', value: state.alphaProgress });
	}

	/* ==================== AUDIO ==================== */

	function initVoices() {
		if (!('speechSynthesis' in window)) return;
		const pickVoice = () => {
			const voices = window.speechSynthesis.getVoices();
			const arabicVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('ar'));
			state.arabicVoice =
				arabicVoices.find((v) => /natural|online/i.test(v.name)) ||
				arabicVoices.find((v) => v.lang.toLowerCase() === 'ar-sa') ||
				arabicVoices[0] ||
				null;
		};
		pickVoice();
		window.speechSynthesis.onvoiceschanged = pickVoice;
	}

	function stopAllAudio() {
		try {
			state.audioPlayer.pause();
			state.audioPlayer.currentTime = 0;
		} catch (_) {}
		if ('speechSynthesis' in window && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
			window.speechSynthesis.cancel();
		}
	}

	function playOnlineTTS(text, rate = 1.0) {
		const urls = [
			`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ar&q=${encodeURIComponent(text)}`,
			`https://translate.google.com/translate_tts?ie=UTF-8&client=gtx&tl=ar&q=${encodeURIComponent(text)}`
		];
		let idx = 0;

		const tryNext = () => {
			if (idx >= urls.length) {
				showToast('Audio konnte nicht geladen werden.');
				return;
			}
			const player = state.audioPlayer;
			player.onerror = () => tryNext();
			player.src = urls[idx++];
			player.playbackRate = Math.max(0.5, Math.min(1.5, rate));
			const p = player.play();
			if (p && typeof p.catch === 'function') p.catch(() => tryNext());
		};

		tryNext();
	}

	function playSystemTTS(text, rate = 1.0, fallback = true) {
		if (!('speechSynthesis' in window) || !state.arabicVoice) {
			if (fallback) playOnlineTTS(text, rate);
			else showToast('Keine arabische Systemstimme installiert.');
			return;
		}

		const synth = window.speechSynthesis;
		const wasSpeaking = synth.speaking || synth.pending;
		if (wasSpeaking) synth.cancel();

		const run = () => {
			const u = new SpeechSynthesisUtterance(text);
			u.voice = state.arabicVoice;
			u.lang = state.arabicVoice.lang || 'ar-SA';
			u.rate = rate;
			u.onerror = () => {
				if (fallback) playOnlineTTS(text, rate);
			};
			synth.speak(u);
		};

		if (wasSpeaking) setTimeout(run, 40);
		else run();
	}

	function speakArabic(text, rate = 1.0) {
		if (!text) return;
		stopAllAudio();
		const mode = state.meta.audioMode || 'auto';
		if (mode === 'online') playOnlineTTS(text, rate);
		else if (mode === 'system') playSystemTTS(text, rate, false);
		else if (state.arabicVoice) playSystemTTS(text, rate, true);
		else playOnlineTTS(text, rate);
	}

	function startSpeechCheck(targetText) {
		const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
		const feedbackEl = $('vocabSpeechLine');
		const btnEl = $('vocabMicBtn');

		if (!SpeechRec) {
			feedbackEl.hidden = false;
			feedbackEl.className = 'inline-note';
			feedbackEl.textContent = 'Spracherkennung nur in Chrome / Edge verfügbar.';
			return;
		}
		if (state.recognition) {
			try { state.recognition.abort(); } catch (_) {}
		}

		const rec = new SpeechRec();
		rec.lang = 'ar-SA';
		rec.interimResults = false;
		rec.maxAlternatives = 3;
		state.recognition = rec;

		btnEl.textContent = 'Höre zu...';
		btnEl.disabled = true;
		feedbackEl.hidden = false;
		feedbackEl.className = 'inline-note';
		feedbackEl.textContent = 'Jetzt sprechen...';

		rec.onresult = (event) => {
			const alts = Array.from(event.results[0]).map((r) => r.transcript);
			const targetNorm = normalizeArabic(targetText);
			const ok = alts.some((alt) => {
				const n = normalizeArabic(alt);
				return n === targetNorm || n.includes(targetNorm) || targetNorm.includes(n);
			});
			feedbackEl.className = ok ? 'inline-note match' : 'inline-note';
			feedbackEl.innerHTML = ok
				? `Erkannt: <strong dir="rtl" lang="ar">${escapeHtml(alts[0])}</strong>`
				: `Gehört: <strong dir="rtl" lang="ar">${escapeHtml(alts[0])}</strong>`;
		};

		rec.onerror = () => {
			feedbackEl.className = 'inline-note';
			feedbackEl.textContent = 'Nicht verstanden — einfach nochmal versuchen.';
		};

		rec.onend = () => {
			btnEl.textContent = 'Sprechen';
			btnEl.disabled = false;
		};

		rec.start();
	}

	/* ==================== ALPHABET (POOL 0 -> 6) ==================== */

	function ensureInitialAlphabetUnlocked() {
		const unlocked = ALPHABET_DATA.filter((item) => Boolean(state.alphaProgress[item.id]));
		if (unlocked.length === 0) {
			for (let i = 0; i < 3; i++) {
				const item = ALPHABET_DATA[i];
				state.alphaProgress[item.id] = { id: item.id, counter: 0 };
			}
			return;
		}
		for (const item of unlocked) {
			const prog = state.alphaProgress[item.id];
			prog.counter = getCounter(prog);
		}
	}

	function rebuildAlphaPool() {
		const pool = [];
		for (const item of ALPHABET_DATA) {
			const prog = state.alphaProgress[item.id];
			if (prog && prog.counter < TARGET_COUNT) {
				pool.push({ item, prog });
			}
		}
		shuffleArray(pool);
		avoidImmediateRepeat(pool, state.alphaLastId, (e) => e.item.id);
		state.alphaPool = pool;
		renderAlphaCard();
	}

	function renderAlphaCard() {
		state.alphaRevealed = false;
		setAnswerVisibility($('alphaAnswer'), false);
		$('alphaGradeRow').hidden = true;

		const unlockedCount = ALPHABET_DATA.filter((i) => Boolean(state.alphaProgress[i.id])).length;
		const learnedCount = ALPHABET_DATA.filter((i) => (state.alphaProgress[i.id]?.counter || 0) >= TARGET_COUNT).length;

		updateTopbarBadge();

		if (state.alphaPool.length === 0) {
			state.alphaCurrent = null;
			$('alphaCard').hidden = true;
			$('alphaDoneCard').hidden = false;
			$('alphaDoneText').textContent = `${learnedCount} von ${ALPHABET_DATA.length} Buchstaben gelernt.`;
			$('alphaDoneUnlockBtn').hidden = unlockedCount >= ALPHABET_DATA.length;
			return;
		}

		const current = state.alphaPool[0];
		state.alphaCurrent = current;

		$('alphaDoneCard').hidden = true;
		$('alphaCard').hidden = false;
		$('alphaRevealBtn').hidden = false;

		renderDots($('alphaDots'), current.prog.counter);
		$('alphaSessionStatus').textContent = `${state.alphaPool.length} offen`;
		$('alphaGlyphBtn').textContent = current.item.char;
		$('alphaName').textContent = current.item.name;
		animatePromptEntry($('alphaGlyphBtn'));
	}

	function revealAlphaCard() {
		if (!state.alphaCurrent || state.alphaRevealed) return;
		state.alphaRevealed = true;

		const { item, prog } = state.alphaCurrent;
		const nextWrong = Math.max(0, prog.counter - 1);
		const nextRight = Math.min(TARGET_COUNT, prog.counter + 1);

		$('alphaWrongHint').textContent = `${nextWrong}/${TARGET_COUNT}`;
		$('alphaRightHint').textContent = nextRight >= TARGET_COUNT ? 'Gelernt' : `${nextRight}/${TARGET_COUNT}`;

		setAnswerVisibility($('alphaAnswer'), true);
		$('alphaRevealBtn').hidden = true;
		$('alphaGradeRow').hidden = false;

		speakArabic(item.speak, 0.95);
	}

	async function answerAlphaCard(isRight) {
		if (!state.alphaCurrent) return;
		const { item, prog } = state.alphaCurrent;
		state.alphaLastId = item.id;

		if (isRight) {
			prog.counter = Math.min(TARGET_COUNT, prog.counter + 1);
		} else {
			prog.counter = Math.max(0, prog.counter - 1);
		}

		state.alphaProgress[item.id] = prog;
		await saveAlphaProgress();

		rebuildAlphaPool();
		if (state.openDrawer === 'pool') renderPoolDrawer();
	}

	async function unlockNextAlpha() {
		const nextItem = ALPHABET_DATA.find((item) => !state.alphaProgress[item.id]);
		if (!nextItem) {
			showToast('Alle 28 Buchstaben sind bereits freigeschaltet.');
			return;
		}
		for (const item of ALPHABET_DATA) {
			if (state.alphaProgress[item.id]) {
				state.alphaProgress[item.id].counter = 0;
			}
		}
		state.alphaProgress[nextItem.id] = { id: nextItem.id, counter: 0 };
		state.alphaLastId = null;
		await saveAlphaProgress();
		rebuildAlphaPool();
		if (state.openDrawer === 'pool') renderPoolDrawer();
		showToast(`Neu: ${nextItem.char} (${nextItem.name}) · Pool auf 0/${TARGET_COUNT} zurückgesetzt`);
	}

	async function resetAlphaCounters(onlyLearned = false) {
		for (const item of ALPHABET_DATA) {
			const prog = state.alphaProgress[item.id];
			if (!prog) continue;
			if (!onlyLearned || prog.counter >= TARGET_COUNT) {
				prog.counter = 0;
			}
		}
		state.alphaLastId = null;
		await saveAlphaProgress();
		rebuildAlphaPool();
		if (state.openDrawer === 'pool') renderPoolDrawer();
	}

	/* ==================== VOKABELN (POOL 0 -> 6) ==================== */

	async function loadVocabState() {
		state.vocabTotal = await idbCount('vocab');
		$('menuVocabInfo').textContent = state.vocabTotal > 0
			? `${state.vocabTotal.toLocaleString('de-DE')} Wörter geladen.`
			: 'Keine Datei geladen.';

		if (state.vocabTotal === 0) {
			state.vocabUnlocked = [];
			state.vocabPool = [];
			state.vocabCurrent = null;
			$('vocabUploadCard').hidden = false;
			$('vocabCard').hidden = true;
			$('vocabDoneCard').hidden = true;
			updateTopbarBadge();
			return;
		}

		const unlocked = await idbGetUnlockedVocab();
		for (const w of unlocked) {
			w.counter = getCounter(w);
		}
		unlocked.sort((a, b) => a.rank - b.rank);
		state.vocabUnlocked = unlocked;

		$('vocabUploadCard').hidden = true;
		rebuildVocabPool();
	}

	function rebuildVocabPool() {
		const pool = state.vocabUnlocked.filter((w) => w.counter < TARGET_COUNT);
		shuffleArray(pool);
		avoidImmediateRepeat(pool, state.vocabLastRank, (w) => w.rank);
		state.vocabPool = pool;
		renderVocabCard();
	}

	function renderVocabAnswerContent(card) {
		const showVocalized = card.vocalized && card.vocalized !== card.word;
		$('vocabVocalized').textContent = showVocalized ? card.vocalized : '';
		$('vocabVocalized').hidden = !showVocalized;

		$('vocabPronunciation').textContent = card.translit || '';
		$('vocabPronunciation').hidden = !card.translit;

		const { meaning, example } = splitMeaningAndExample(card.meaning);
		$('vocabMeaning').textContent = meaning || 'Keine Bedeutung hinterlegt';
		$('vocabExample').textContent = example;
		$('vocabExample').hidden = !example;

		$('vocabPonsLink').href = `https://de.pons.com/%C3%BCbersetzung/arabisch-deutsch/${encodeURIComponent(card.word)}`;
	}

	function renderVocabCard() {
		state.vocabRevealed = false;
		setAnswerVisibility($('vocabAnswer'), false);
		$('vocabEditForm').hidden = true;
		$('vocabGradeRow').hidden = true;
		$('vocabHintLine').hidden = true;
		$('vocabSpeechLine').hidden = true;

		updateTopbarBadge();

		if (state.vocabTotal === 0) return;

		if (state.vocabPool.length === 0) {
			state.vocabCurrent = null;
			$('vocabCard').hidden = true;
			$('vocabDoneCard').hidden = false;
			const learned = state.vocabUnlocked.filter((w) => w.counter >= TARGET_COUNT).length;
			$('vocabDoneText').textContent = `${learned.toLocaleString('de-DE')} von ${state.vocabTotal.toLocaleString('de-DE')} Wörtern gelernt.`;
			const canUnlockMore = state.vocabUnlocked.length < state.vocabTotal;
			$('vocabDoneUnlockOne').hidden = !canUnlockMore;
			$('vocabDoneUnlockFive').hidden = !canUnlockMore;
			return;
		}

		const card = state.vocabPool[0];
		state.vocabCurrent = card;

		$('vocabDoneCard').hidden = true;
		$('vocabCard').hidden = false;
		$('vocabRevealBtn').hidden = false;

		renderDots($('vocabDots'), card.counter);
		$('vocabSessionStatus').textContent = `#${card.rank} · ${state.vocabPool.length} offen`;
		$('vocabWordBtn').textContent = card.word;
		renderVocabAnswerContent(card);
		animatePromptEntry($('vocabWordBtn'));
	}

	function revealVocabCard() {
		if (!state.vocabCurrent || state.vocabRevealed) return;
		state.vocabRevealed = true;

		const card = state.vocabCurrent;
		const nextWrong = Math.max(0, card.counter - 1);
		const nextRight = Math.min(TARGET_COUNT, card.counter + 1);

		$('vocabWrongHint').textContent = `${nextWrong}/${TARGET_COUNT}`;
		$('vocabRightHint').textContent = nextRight >= TARGET_COUNT ? 'Gelernt' : `${nextRight}/${TARGET_COUNT}`;

		setAnswerVisibility($('vocabAnswer'), true);
		$('vocabRevealBtn').hidden = true;
		$('vocabGradeRow').hidden = false;

		speakArabic(card.vocalized || card.word, 0.95);
	}

	async function answerVocabCard(isRight) {
		if (!state.vocabCurrent) return;
		const card = state.vocabCurrent;
		state.vocabLastRank = card.rank;

		if (isRight) {
			card.counter = Math.min(TARGET_COUNT, card.counter + 1);
		} else {
			card.counter = Math.max(0, card.counter - 1);
		}

		await idbPut('vocab', card);
		rebuildVocabPool();
		if (state.openDrawer === 'pool') renderPoolDrawer();
	}

	async function unlockNextVocab(count) {
		if (state.vocabTotal === 0) return;
		const nextRankStart = state.vocabUnlocked.length + 1;
		const newlyUnlocked = [];

		for (let r = nextRankStart; r < nextRankStart + count; r++) {
			const rec = await idbGet('vocab', r);
			if (!rec) break;
			if (rec.unlocked !== 1) {
				rec.unlocked = 1;
				rec.counter = 0;
				newlyUnlocked.push(rec);
			}
		}

		if (newlyUnlocked.length === 0) {
			showToast('Keine weiteren Wörter in der Liste.');
			return;
		}

		for (const w of state.vocabUnlocked) {
			w.counter = 0;
		}
		state.vocabUnlocked.push(...newlyUnlocked);
		state.vocabUnlocked.sort((a, b) => a.rank - b.rank);

		await idbBulkPutVocab(state.vocabUnlocked);
		state.vocabLastRank = null;
		rebuildVocabPool();
		if (state.openDrawer === 'pool') renderPoolDrawer();
		showToast(`${newlyUnlocked.length} ${newlyUnlocked.length === 1 ? 'Wort' : 'Wörter'} neu · Pool auf 0/${TARGET_COUNT} zurückgesetzt`);
	}

	async function resetVocabCounters(onlyLearned = false) {
		const updated = [];
		for (const w of state.vocabUnlocked) {
			if (!onlyLearned || w.counter >= TARGET_COUNT) {
				w.counter = 0;
				updated.push(w);
			}
		}
		if (updated.length > 0) {
			await idbBulkPutVocab(updated);
		}
		state.vocabLastRank = null;
		rebuildVocabPool();
		if (state.openDrawer === 'pool') renderPoolDrawer();
	}

	function parseVocabRecords(rawText, maxImport) {
		const text = rawText.replace(/^\uFEFF/, '');
		const lines = text.split(/\r?\n/);
		const firstCols = (lines[0] || '').split('\t');
		const isPrepared =
			firstCols.length >= 6 &&
			firstCols[0].trim().toLowerCase() === 'rank' &&
			firstCols[1].trim().toLowerCase() === 'word';

		if (isPrepared) {
			const records = [];
			for (let i = 1; i < lines.length && records.length < maxImport; i++) {
				const line = lines[i];
				if (!line) continue;
				const cols = line.split('\t');
				const word = (cols[1] || '').trim();
				if (!word) continue;
				const rank = records.length + 1;
				records.push({
					rank,
					word,
					vocalized: (cols[2] || '').trim(),
					translit: (cols[3] || '').trim(),
					meaning: (cols[4] || '').trim(),
					freq: parseInt(cols[5], 10) || 0,
					unlocked: rank <= 5 ? 1 : 0,
					counter: 0
				});
			}
			return records;
		}

		const freqMap = new Map();
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;
			const cols = line.includes('\t') ? line.split('\t') : line.split(/\s+/);
			let rawWord = '';
			let freq = 0;
			if (cols.length >= 3 && /^\d+$/.test(cols[0])) {
				rawWord = cols[1].trim();
				freq = parseInt(cols[2], 10) || 0;
			} else if (cols.length >= 2) {
				rawWord = cols[0].trim();
				freq = parseInt(cols[1], 10) || 0;
			} else {
				continue;
			}
			rawWord = rawWord.replace(/\u0640/g, '');
			if (!rawWord || !isArabicWord(rawWord)) continue;
			freqMap.set(rawWord, (freqMap.get(rawWord) || 0) + freq);
		}

		const sorted = Array.from(freqMap.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, maxImport);

		return sorted.map(([word, freq], idx) => {
			const rank = idx + 1;
			return {
				rank,
				word,
				vocalized: '',
				translit: '',
				meaning: '',
				freq,
				unlocked: rank <= 5 ? 1 : 0,
				counter: 0
			};
		});
	}

	async function importVocabText(rawText, { isAutoLoad = false } = {}) {
		const maxImport = Math.max(100, parseInt($('vocabMaxImport').value, 10) || 50000);

		if (!isAutoLoad) {
			closeDrawers();
			switchMode('vocab');
		}

		$('vocabUploadCard').hidden = false;
		$('vocabCard').hidden = true;
		$('vocabDoneCard').hidden = true;
		$('importProgressWrap').hidden = false;
		$('importProgressFill').style.width = '20%';
		$('importProgressText').textContent = 'Verarbeite Vokabeln...';

		const records = parseVocabRecords(rawText, maxImport);

		if (records.length === 0) {
			$('importProgressWrap').hidden = true;
			if (!isAutoLoad) {
				showToast('Keine gültigen arabischen Wörter gefunden.');
			}
			return false;
		}

		$('importProgressFill').style.width = '50%';
		$('importProgressText').textContent = `Speichere ${records.length.toLocaleString('de-DE')} Wörter...`;

		await idbClear('vocab');
		await idbBulkPutVocab(records, (done, total) => {
			const pct = 50 + Math.round((done / total) * 50);
			$('importProgressFill').style.width = `${pct}%`;
			$('importProgressText').textContent = `${done.toLocaleString('de-DE')} / ${total.toLocaleString('de-DE')}`;
		});

		$('importProgressWrap').hidden = true;
		state.vocabLastRank = null;
		await loadVocabState();
		if (state.openDrawer === 'pool' && state.mode === 'vocab') {
			renderPoolDrawer();
		}
		if (!isAutoLoad) {
			showToast(`${records.length.toLocaleString('de-DE')} Wörter geladen.`);
		}
		return true;
	}

	async function parseAndImportFile(file) {
		const text = await file.text();
		await importVocabText(text, { isAutoLoad: false });
	}

	async function tryAutoLoadDefaultVocab() {
		if (!DEFAULT_VOCAB_FILE) return;
		try {
			$('importProgressWrap').hidden = false;
			$('importProgressFill').style.width = '10%';
			$('importProgressText').textContent = 'Lade Vokabelliste...';

			const response = await fetch(DEFAULT_VOCAB_FILE, { cache: 'no-cache' });
			if (!response.ok) {
				$('importProgressWrap').hidden = true;
				return;
			}
			const text = await response.text();
			await importVocabText(text, { isAutoLoad: true });
		} catch (_) {
			$('importProgressWrap').hidden = true;
		}
	}

	/* ==================== DRAWERS & NAVIGATION ==================== */

	function updateTopbarBadge() {
		if (state.mode === 'alphabet') {
			$('poolCountBadge').textContent = String(state.alphaPool.length);
		} else {
			$('poolCountBadge').textContent = String(state.vocabPool.length);
		}
	}

	function switchMode(mode) {
		state.mode = mode;
		document.querySelectorAll('.mode-btn').forEach((btn) => {
			const active = btn.dataset.mode === mode;
			btn.classList.toggle('active', active);
			btn.setAttribute('aria-selected', String(active));
		});
		$('view-alphabet').hidden = mode !== 'alphabet';
		$('view-vocab').hidden = mode !== 'vocab';
		updateTopbarBadge();
	}

	function openDrawer(which) {
		closeDrawers();
		state.openDrawer = which;
		$('drawerBackdrop').hidden = false;
		if (which === 'pool') {
			renderPoolDrawer();
			$('poolDrawer').hidden = false;
		} else if (which === 'menu') {
			$('menuDrawer').hidden = false;
		}
	}

	function closeDrawers() {
		state.openDrawer = null;
		$('drawerBackdrop').hidden = true;
		$('poolDrawer').hidden = true;
		$('menuDrawer').hidden = true;
	}

	function renderPoolDrawer() {
		const listEl = $('poolList');

		if (state.mode === 'alphabet') {
			const unlockedCount = ALPHABET_DATA.filter((i) => Boolean(state.alphaProgress[i.id])).length;
			const learnedCount = ALPHABET_DATA.filter((i) => (state.alphaProgress[i.id]?.counter || 0) >= TARGET_COUNT).length;

			$('poolDrawerTitle').textContent = 'Alphabet-Pool';
			$('poolDrawerSubtitle').textContent = `${state.alphaPool.length} offen · ${learnedCount} gelernt · ${unlockedCount}/${ALPHABET_DATA.length} freigeschaltet`;
			$('poolUnlockOneBtn').textContent = '+1 Buchstabe';
			$('poolUnlockOneBtn').disabled = unlockedCount >= ALPHABET_DATA.length;
			$('poolUnlockFiveBtn').hidden = true;
			$('poolSearchInput').hidden = true;

			listEl.innerHTML = ALPHABET_DATA.map((item, idx) => {
				const prog = state.alphaProgress[item.id];
				const unlocked = Boolean(prog);
				const count = unlocked ? prog.counter : 0;
				const done = count >= TARGET_COUNT;
				return `
					<div class="pool-item${unlocked ? '' : ' locked'}">
						<button class="pool-item-main" type="button" data-speak="${escapeHtml(item.speak)}">
							<span class="pool-ar" dir="rtl" lang="ar">${escapeHtml(item.char)}</span>
							<span class="pool-text">
								<span class="pool-title">${escapeHtml(item.name)}</span>
								<span class="pool-sub">#${idx + 1}</span>
							</span>
						</button>
						<div class="pool-item-right">
							${unlocked
								? `<span class="counter-pill${done ? ' done' : ''}">${count}/${TARGET_COUNT}</span>`
								: '<span class="counter-pill">Gesperrt</span>'}
							${unlocked && count > 0
								? `<button class="text-btn" type="button" data-reset-alpha="${escapeHtml(item.id)}" title="Auf 0/6 zurücksetzen">↺</button>`
								: ''}
						</div>
					</div>
				`;
			}).join('');
			return;
		}

		// Vocab Pool
		const learnedCount = state.vocabUnlocked.filter((w) => w.counter >= TARGET_COUNT).length;
		$('poolDrawerTitle').textContent = 'Vokabel-Pool';
		$('poolDrawerSubtitle').textContent = state.vocabTotal > 0
			? `${state.vocabPool.length} offen · ${learnedCount} gelernt · ${state.vocabUnlocked.length}/${state.vocabTotal.toLocaleString('de-DE')}`
			: 'Noch keine Vokabel-Datei geladen.';

		const canUnlock = state.vocabUnlocked.length < state.vocabTotal;
		$('poolUnlockOneBtn').textContent = '+1 Wort';
		$('poolUnlockOneBtn').disabled = !canUnlock;
		$('poolUnlockFiveBtn').hidden = state.vocabTotal === 0;
		$('poolUnlockFiveBtn').disabled = !canUnlock;
		$('poolSearchInput').hidden = state.vocabUnlocked.length === 0;

		if (state.vocabUnlocked.length === 0) {
			listEl.innerHTML = '<p class="muted small">Lade zuerst eine Frequenzliste im Tab „Vokabeln“ oder über das Menü.</p>';
			return;
		}

		const q = $('poolSearchInput').value.trim().toLowerCase();
		const filtered = state.vocabUnlocked
			.filter((w) => {
				if (!q) return true;
				return (
					w.word.includes(q) ||
					(w.vocalized || '').includes(q) ||
					(w.translit || '').toLowerCase().includes(q) ||
					(w.meaning || '').toLowerCase().includes(q)
				);
			})
			.slice(0, 300);

		listEl.innerHTML = filtered.map((w) => {
			const done = w.counter >= TARGET_COUNT;
			const { meaning } = splitMeaningAndExample(w.meaning);
			return `
				<div class="pool-item">
					<button class="pool-item-main" type="button" data-speak="${escapeHtml(w.vocalized || w.word)}">
						<span class="pool-ar" dir="rtl" lang="ar">${escapeHtml(w.vocalized || w.word)}</span>
						<span class="pool-text">
							<span class="pool-title">${escapeHtml(meaning || '—')}</span>
							<span class="pool-sub">#${w.rank}${w.translit ? ` · ${escapeHtml(w.translit)}` : ''}</span>
						</span>
					</button>
					<div class="pool-item-right">
						<span class="counter-pill${done ? ' done' : ''}">${w.counter}/${TARGET_COUNT}</span>
						${w.counter > 0
							? `<button class="text-btn" type="button" data-reset-vocab="${w.rank}" title="Auf 0/6 zurücksetzen">↺</button>`
							: ''}
					</div>
				</div>
			`;
		}).join('');
	}

	/* ==================== THEME & BACKUP ==================== */

	function applyTheme(theme) {
		state.meta.theme = theme;
		if (theme === 'dark') {
			document.documentElement.setAttribute('data-theme', 'dark');
		} else if (theme === 'light') {
			document.documentElement.removeAttribute('data-theme');
		} else {
			const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
			if (prefersDark) document.documentElement.setAttribute('data-theme', 'dark');
			else document.documentElement.removeAttribute('data-theme');
		}
	}

	async function exportBackup() {
		const payload = {
			exportedAt: new Date().toISOString(),
			meta: state.meta,
			alphaProgress: state.alphaProgress,
			unlockedVocab: state.vocabUnlocked
		};
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `arabisch-backup-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
		showToast('Backup gespeichert.');
	}

	async function importBackup(file) {
		try {
			const data = JSON.parse(await file.text());
			if (data.meta) {
				state.meta = { ...state.meta, ...data.meta };
				await saveMeta();
			}
			if (data.alphaProgress) {
				state.alphaProgress = data.alphaProgress;
				ensureInitialAlphabetUnlocked();
				await saveAlphaProgress();
			}
			if (Array.isArray(data.unlockedVocab) && data.unlockedVocab.length > 0) {
				for (const w of data.unlockedVocab) {
					w.counter = getCounter(w);
				}
				await idbBulkPutVocab(data.unlockedVocab);
			}
			applyTheme(state.meta.theme);
			$('themeSelect').value = state.meta.theme;
			$('audioModeSelect').value = state.meta.audioMode || 'auto';
			rebuildAlphaPool();
			await loadVocabState();
			closeDrawers();
			showToast('Backup wiederhergestellt.');
		} catch (_) {
			showToast('Backup-Datei ungültig.');
		}
	}

	/* ==================== EVENTS ==================== */

	function bindEvents() {
		document.querySelectorAll('.mode-btn').forEach((btn) => {
			btn.addEventListener('click', () => switchMode(btn.dataset.mode));
		});

		$('openPoolBtn').addEventListener('click', () => openDrawer('pool'));
		$('openMenuBtn').addEventListener('click', () => openDrawer('menu'));
		$('drawerBackdrop').addEventListener('click', closeDrawers);
		document.querySelectorAll('[data-close-drawer]').forEach((btn) => {
			btn.addEventListener('click', closeDrawers);
		});

		// Alphabet
		$('alphaGlyphBtn').addEventListener('click', () => {
			if (state.alphaCurrent) speakArabic(state.alphaCurrent.item.speak, 0.95);
		});
		$('alphaRevealBtn').addEventListener('click', revealAlphaCard);
		$('alphaWrongBtn').addEventListener('click', () => answerAlphaCard(false));
		$('alphaRightBtn').addEventListener('click', () => answerAlphaCard(true));
		$('alphaDoneUnlockBtn').addEventListener('click', unlockNextAlpha);
		$('alphaDoneRepeatBtn').addEventListener('click', () => resetAlphaCounters(true));

		// Vocab
		$('tsvFileInput').addEventListener('change', (e) => {
			if (e.target.files[0]) parseAndImportFile(e.target.files[0]);
			e.target.value = '';
		});
		$('menuFileInput').addEventListener('change', (e) => {
			if (e.target.files[0]) parseAndImportFile(e.target.files[0]);
			e.target.value = '';
		});

		$('vocabWordBtn').addEventListener('click', () => {
			if (state.vocabCurrent) speakArabic(state.vocabCurrent.vocalized || state.vocabCurrent.word, 1.0);
		});
		$('vocabSlowBtn').addEventListener('click', () => {
			if (state.vocabCurrent) speakArabic(state.vocabCurrent.vocalized || state.vocabCurrent.word, 0.7);
		});
		$('vocabMicBtn').addEventListener('click', () => {
			if (state.vocabCurrent) startSpeechCheck(state.vocabCurrent.word);
		});
		$('vocabHintBtn').addEventListener('click', () => {
			if (!state.vocabCurrent) return;
			const parts = [];
			if (state.vocabCurrent.vocalized && state.vocabCurrent.vocalized !== state.vocabCurrent.word) {
				parts.push(state.vocabCurrent.vocalized);
			}
			if (state.vocabCurrent.translit) parts.push(state.vocabCurrent.translit);
			$('vocabHintLine').textContent = parts.length ? parts.join(' · ') : 'Keine Hilfe gespeichert';
			$('vocabHintLine').hidden = false;
		});

		$('vocabRevealBtn').addEventListener('click', revealVocabCard);
		$('vocabWrongBtn').addEventListener('click', () => answerVocabCard(false));
		$('vocabRightBtn').addEventListener('click', () => answerVocabCard(true));
		$('vocabDoneUnlockOne').addEventListener('click', () => unlockNextVocab(1));
		$('vocabDoneUnlockFive').addEventListener('click', () => unlockNextVocab(5));
		$('vocabDoneRepeatBtn').addEventListener('click', () => resetVocabCounters(true));

		$('vocabEditBtn').addEventListener('click', () => {
			if (!state.vocabCurrent) return;
			$('editVocalized').value = state.vocabCurrent.vocalized || '';
			$('editTranslit').value = state.vocabCurrent.translit || '';
			$('editMeaning').value = state.vocabCurrent.meaning || '';
			$('vocabEditForm').hidden = false;
		});
		$('vocabEditCancel').addEventListener('click', () => {
			$('vocabEditForm').hidden = true;
		});
		$('vocabEditForm').addEventListener('submit', async (e) => {
			e.preventDefault();
			if (!state.vocabCurrent) return;
			state.vocabCurrent.vocalized = $('editVocalized').value.trim();
			state.vocabCurrent.translit = $('editTranslit').value.trim();
			state.vocabCurrent.meaning = $('editMeaning').value.trim();
			await idbPut('vocab', state.vocabCurrent);
			renderVocabAnswerContent(state.vocabCurrent);
			$('vocabEditForm').hidden = true;
			showToast('Gespeichert.');
		});

		// Pool drawer actions
		$('poolUnlockOneBtn').addEventListener('click', () => {
			if (state.mode === 'alphabet') unlockNextAlpha();
			else unlockNextVocab(1);
		});
		$('poolUnlockFiveBtn').addEventListener('click', () => unlockNextVocab(5));
		$('poolSearchInput').addEventListener('input', renderPoolDrawer);

		$('poolList').addEventListener('click', async (e) => {
			const resetAlphaBtn = e.target.closest('[data-reset-alpha]');
			if (resetAlphaBtn) {
				const id = resetAlphaBtn.dataset.resetAlpha;
				if (state.alphaProgress[id]) {
					state.alphaProgress[id].counter = 0;
					await saveAlphaProgress();
					rebuildAlphaPool();
					renderPoolDrawer();
				}
				return;
			}
			const resetVocabBtn = e.target.closest('[data-reset-vocab]');
			if (resetVocabBtn) {
				const rank = parseInt(resetVocabBtn.dataset.resetVocab, 10);
				const item = state.vocabUnlocked.find((w) => w.rank === rank);
				if (item) {
					item.counter = 0;
					await idbPut('vocab', item);
					rebuildVocabPool();
					renderPoolDrawer();
				}
				return;
			}
			const speakBtn = e.target.closest('[data-speak]');
			if (speakBtn) {
				speakArabic(speakBtn.dataset.speak, 0.95);
			}
		});

		// Menu settings
		$('themeSelect').addEventListener('change', async (e) => {
			applyTheme(e.target.value);
			await saveMeta();
		});
		$('audioModeSelect').addEventListener('change', async (e) => {
			state.meta.audioMode = e.target.value;
			await saveMeta();
		});
		$('exportBackupBtn').addEventListener('click', exportBackup);
		$('importBackupInput').addEventListener('change', (e) => {
			if (e.target.files[0]) importBackup(e.target.files[0]);
			e.target.value = '';
		});

		$('resetAlphaBtn').addEventListener('click', async () => {
			if (!confirm('Alphabet komplett zurücksetzen?')) return;
			state.alphaProgress = {};
			state.alphaLastId = null;
			ensureInitialAlphabetUnlocked();
			await saveAlphaProgress();
			rebuildAlphaPool();
			closeDrawers();
			showToast('Alphabet zurückgesetzt.');
		});

		$('resetVocabProgressBtn').addEventListener('click', async () => {
			if (!confirm('Alle freigeschalteten Vokabeln wieder auf 0/6 setzen?')) return;
			await resetVocabCounters(false);
			closeDrawers();
			showToast('Fortschritt zurückgesetzt.');
		});

		$('deleteVocabBtn').addEventListener('click', async () => {
			if (!confirm('Geladene Vokabel-Datei wirklich löschen?')) return;
			await idbClear('vocab');
			state.vocabLastRank = null;
			await loadVocabState();
			closeDrawers();
			showToast('Vokabel-Datei gelöscht.');
		});

		// Keyboard shortcuts
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && state.openDrawer) {
				closeDrawers();
				return;
			}
			if (state.openDrawer) return;
			const tag = e.target.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

			if (state.mode === 'alphabet' && state.alphaCurrent) {
				if (e.code === 'Space') {
					e.preventDefault();
					if (!state.alphaRevealed) revealAlphaCard();
				} else if ((e.key === '1' || e.key === 'ArrowLeft') && state.alphaRevealed) {
					answerAlphaCard(false);
				} else if ((e.key === '2' || e.key === 'ArrowRight') && state.alphaRevealed) {
					answerAlphaCard(true);
				} else if (e.key.toLowerCase() === 'a') {
					speakArabic(state.alphaCurrent.item.speak, 0.95);
				}
			} else if (state.mode === 'vocab' && state.vocabCurrent) {
				if (e.code === 'Space') {
					e.preventDefault();
					if (!state.vocabRevealed) revealVocabCard();
				} else if ((e.key === '1' || e.key === 'ArrowLeft') && state.vocabRevealed) {
					answerVocabCard(false);
				} else if ((e.key === '2' || e.key === 'ArrowRight') && state.vocabRevealed) {
					answerVocabCard(true);
				} else if (e.key.toLowerCase() === 'a') {
					speakArabic(state.vocabCurrent.vocalized || state.vocabCurrent.word, 1.0);
				} else if (e.key.toLowerCase() === 's') {
					speakArabic(state.vocabCurrent.vocalized || state.vocabCurrent.word, 0.7);
				} else if (e.key.toLowerCase() === 'm') {
					startSpeechCheck(state.vocabCurrent.word);
				}
			}
		});
	}

	async function init() {
		initVoices();
		state.db = await openDatabase();

		const savedMeta = await idbGet('meta', 'appMeta');
		if (savedMeta && savedMeta.value) {
			state.meta = { ...state.meta, ...savedMeta.value };
		}

		const savedAlpha = await idbGet('meta', 'alphaProgress');
		if (savedAlpha && savedAlpha.value) {
			state.alphaProgress = savedAlpha.value;
		}
		ensureInitialAlphabetUnlocked();
		await saveAlphaProgress();

		applyTheme(state.meta.theme || 'auto');
		$('themeSelect').value = state.meta.theme;
		$('audioModeSelect').value = state.meta.audioMode || 'auto';

		bindEvents();
		rebuildAlphaPool();
		await loadVocabState();

		if (state.vocabTotal === 0) {
			tryAutoLoadDefaultVocab();
		}
	}

	document.addEventListener('DOMContentLoaded', init);
})();