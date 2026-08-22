// Headless smoke test for the injected picker script.
const puppeteer = require("puppeteer-core");
const { installPiPicker } = require("./node_modules/.tmp-picker.cjs");

(async () => {
	const browser = await puppeteer.launch({ channel: "chrome", headless: true });
	const page = await browser.newPage();

	await page.exposeFunction("__piAnnotate", (payload) => {
		global.__lastAnnotation = payload;
	});
	await page.evaluateOnNewDocument(installPiPicker);

	await page.goto(
		"data:text/html," +
			encodeURIComponent(`
		<html><head><title>test app</title></head><body>
			<app-root _nghost-abc="">
				<div class="container">
					<button id="save-btn" class="btn primary">Save</button>
					<button class="btn">Cancel</button>
				</div>
			</app-root>
		</body></html>
	`),
	);
	await page.waitForFunction(() => !!window.__piPicker);

	// 1. API exists and toggles
	const toggled = await page.evaluate(() => {
		window.__piPicker.setActive(true);
		return window.__piPicker.isActive();
	});
	console.log("setActive/isActive:", toggled ? "PASS" : "FAIL");

	// 2. findByPath round-trip
	const found = await page.evaluate(() => {
		const btn = document.querySelector("#save-btn");
		// rebuild the path the same way the picker does
		const path = [];
		let cur = btn;
		while (cur && cur !== document.documentElement) {
			const parent = cur.parentElement;
			const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
			path.unshift({ tag: cur.tagName.toLowerCase(), index: same.indexOf(cur) });
			cur = parent;
		}
		return window.__piPicker.findByPath(path) === btn;
	});
	console.log("findByPath:", found ? "PASS" : "FAIL");

	// 3. Simulate a click annotation (synthesizes the payload the click handler builds)
	const payload = await page.evaluate(() => {
		const btn = document.querySelector("#save-btn");
		// dispatch a real click so the picker's capture handler fires
		btn.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
		btn.click();
		return new Promise((resolve) => {
			const check = () => {
				const ta = document.querySelector("div") && window.__piPicker;
				resolve(!!document.querySelector("#save-btn"));
			};
			setTimeout(() => {
				// dialog should be open now; type a note and submit
				const host = document.body.lastElementChild; // dialog host
				const shadow = host.shadowRoot;
				if (!shadow) return resolve({ dialog: false });
				shadow.querySelector("textarea").value = "Make this button green";
				shadow.querySelector(".save").click();
				resolve({ dialog: true });
			}, 100);
		});
	});
	await new Promise((r) => setTimeout(r, 300));
	const ann = global.__lastAnnotation;
	console.log("click->dialog->submit:", payload.dialog && ann ? "PASS" : "FAIL");
	if (ann) {
		console.log("  note:", ann.note);
		console.log("  selector:", ann.selector);
		console.log("  components:", JSON.stringify(ann.components));
		console.log("  text:", ann.text);
		console.log("  domPath length:", ann.domPath.length);
		console.log("  url:", ann.url);
	}

	await browser.close();
})().catch((e) => {
	console.error("ERROR:", e.message);
	process.exit(1);
});
