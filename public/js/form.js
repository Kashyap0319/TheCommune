/**
 * Lead form submission handler
 * POSTs form data to /lead endpoint → Zoho CRM
 */
(function () {
    const form = document.getElementById('leadForm');
    if (!form) return;

    const alertEl = document.getElementById('formAlert');
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn ? submitBtn.textContent : 'Submit';

    form.addEventListener('submit', async function (e) {
        e.preventDefault();

        // Basic phone validation
        const phone = form.phone.value.trim();
        if (!/^\d{10}$/.test(phone)) {
            showAlert('Please enter a valid 10-digit WhatsApp number.', 'error');
            return;
        }

        // Disable button + show loading state
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Sending...';
        }
        hideAlert();

        const payload = {
            name:    form.name.value.trim(),
            phone:   phone,
            type:    form.type.value,
            area:    form.area.value,
            budget:  form.budget.value,
            movein:  form.movein ? form.movein.value : '',
        };

        try {
            const response = await fetch('/lead', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (response.ok) {
                showAlert('Done! We will reach out on WhatsApp within 24 hours.', 'success');
                form.reset();
            } else {
                const data = await response.json().catch(() => ({}));
                showAlert(data.message || 'Something went wrong. Please try again.', 'error');
            }
        } catch (err) {
            showAlert('Could not connect. Please check your internet and try again.', 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalBtnText;
            }
        }
    });

    function showAlert(message, type) {
        if (!alertEl) return;
        alertEl.textContent = message;
        alertEl.className = 'form-alert ' + type;
    }

    function hideAlert() {
        if (!alertEl) return;
        alertEl.className = 'form-alert';
        alertEl.textContent = '';
    }
})();
