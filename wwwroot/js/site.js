// + / - buttons for quantity boxes, and select-all when a quantity box is clicked.
(function () {
    document.addEventListener('click', function (e) {
        var btn = e.target.closest('.qty-btn');
        if (!btn) return;

        var wrap = btn.closest('.qty-stepper');
        var input = wrap ? wrap.querySelector('input[type="number"]') : null;
        if (!input) return;

        var step = parseInt(input.step) || 1;
        var min = input.min !== '' ? parseInt(input.min) : 0;
        var max = input.max !== '' ? parseInt(input.max) : Number.MAX_SAFE_INTEGER;
        var value = parseInt(input.value);
        if (isNaN(value)) value = 0;

        value += btn.classList.contains('qty-plus') ? step : -step;
        value = Math.max(min, Math.min(max, value));

        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    document.addEventListener('focusin', function (e) {
        if (e.target.classList && e.target.classList.contains('qty-input')) {
            e.target.select();
        }
    });
})();