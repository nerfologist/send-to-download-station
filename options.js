const DEFAULTS = {
  nasUrl: '',
  username: '',
  password: '',
  destination: '',
  intercept: true,
};
const $ = (id) => document.getElementById(id);
const status = $('status');
const dialog = $('otpDialog');

chrome.storage.local.get(DEFAULTS).then((s) => {
  for (const key of ['nasUrl', 'username', 'password', 'destination']) $(key).value = s[key];
  $('intercept').checked = s.intercept;
});

let lastSeconds = '';

function showResult(res) {
  status.className = res.ok ? 'ok' : 'err';
  status.textContent = res.ok
    ? `Saved — login OK (NAS answered in ${lastSeconds} s)`
    : `Saved, but: ${res.message}`;
}

// Runs a login test with every button disabled, and records how long the NAS took.
async function test(otp) {
  const buttons = document.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  const started = performance.now();
  try {
    return await chrome.runtime.sendMessage({ type: 'test', otp });
  } finally {
    lastSeconds = ((performance.now() - started) / 1000).toFixed(1);
    buttons.forEach((b) => (b.disabled = false));
  }
}

function askOtp(error = '') {
  $('otp').value = '';
  $('otpError').style.color = '';
  $('otpError').textContent = error;
  if (!dialog.open) dialog.showModal();
  $('otp').focus();
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  status.className = '';
  status.textContent = 'Testing…';
  await chrome.storage.local.set({
    nasUrl: $('nasUrl').value.trim(),
    username: $('username').value.trim(),
    password: $('password').value,
    destination: $('destination').value.trim().replace(/^\/+/, ''),
    intercept: $('intercept').checked,
  });
  const res = await test();
  if (res.needOtp) {
    status.textContent = 'Waiting for 2FA code…';
    askOtp();
  } else {
    showResult(res);
  }
});

$('otpForm').addEventListener('submit', async (e) => {
  e.preventDefault(); // keep the dialog open until the code is accepted
  $('otpError').style.color = 'inherit';
  $('otpError').textContent = 'Verifying with the NAS…';
  const res = await test($('otp').value.trim());
  if (res.needOtp) return askOtp('Wrong or expired code, try again.');
  dialog.close();
  showResult(res);
});

$('disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  $('password').value = '';
  status.className = '';
  status.textContent = 'Disconnected — password and device token removed';
});

function cancelOtp() {
  dialog.close();
  showResult({ ok: false, message: '2-factor code not entered' });
}
$('otpCancel').addEventListener('click', cancelOtp);
dialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  cancelOtp();
});
