const api = window.bisonDesktop;
const params = new URLSearchParams(window.location.search);
const email = (params.get('email') || '').trim();
const inputs = [...document.querySelectorAll('#otp input')];
const submitBtn = document.getElementById('submit');
const resendBtn = document.getElementById('resend');
const backBtn = document.getElementById('back');
const errorEl = document.getElementById('error');
const okEl = document.getElementById('ok');

document.getElementById('email').textContent = email || 'your email';

function showError(message) {
  okEl.style.display = 'none';
  errorEl.textContent = message || 'Verification failed';
  errorEl.style.display = 'block';
}

function showOk(message) {
  errorEl.style.display = 'none';
  okEl.textContent = message;
  okEl.style.display = 'block';
}

function otpValue() {
  return inputs.map((el) => el.value).join('');
}

inputs.forEach((input, index) => {
  input.addEventListener('input', (event) => {
    const value = event.target.value.replace(/\D/g, '').slice(-1);
    event.target.value = value;
    if (value && index < inputs.length - 1) inputs[index + 1].focus();
    if (otpValue().length === 6) submitBtn.click();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && !input.value && index > 0) {
      inputs[index - 1].focus();
    }
  });
  input.addEventListener('paste', (event) => {
    event.preventDefault();
    const pasted = (event.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    pasted.split('').forEach((char, i) => {
      if (inputs[i]) inputs[i].value = char;
    });
    inputs[Math.min(pasted.length, 5)].focus();
  });
});

submitBtn.addEventListener('click', async () => {
  const otp = otpValue();
  if (otp.length !== 6) {
    showError('Enter the complete 6-digit OTP');
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = 'Verifying…';
  try {
    const result = await api.auth.verifyOtp(email, otp);
    if (!result || !result.success) {
      showError(result?.message || 'Invalid OTP');
      return;
    }
    showOk('Verified. Opening POS…');
  } catch (err) {
    showError(err.message || 'Network error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Verify OTP';
  }
});

resendBtn.addEventListener('click', async () => {
  resendBtn.disabled = true;
  try {
    const result = await api.auth.resendOtp(email);
    if (!result || !result.success) {
      showError(result?.message || 'Could not resend OTP');
      return;
    }
    showOk('OTP resent. Check your email.');
    inputs.forEach((el) => { el.value = ''; });
    inputs[0].focus();
  } catch (err) {
    showError(err.message || 'Network error');
  } finally {
    resendBtn.disabled = false;
  }
});

backBtn.addEventListener('click', () => api.auth.openLogin());
inputs[0].focus();
