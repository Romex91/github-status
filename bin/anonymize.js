// Paste into browser console to anonymize the dashboard for screenshots.
// Replaces repo names, usernames, and branch names. Keeps PR titles as-is.
(function() {
  const repoMap = {};
  const userMap = {};
  let repoN = 0;
  let userN = 0;

  function anonRepo(name) {
    if (!repoMap[name]) repoMap[name] = 'project-' + (++repoN);
    return repoMap[name];
  }

  function anonUser(name) {
    if (!userMap[name]) userMap[name] = 'user-' + (++userN);
    return userMap[name];
  }

  // Collect all real usernames first so we can replace them everywhere
  document.querySelectorAll('.author').forEach(function(el) {
    var name = el.textContent.replace(/^@/, '').trim();
    if (name) anonUser(name);
  });

  // Repo names — collect originals, then replace
  var repoOriginals = [];
  document.querySelectorAll('.repo-col').forEach(function(el) {
    if (el.tagName === 'TH') return;
    var name = el.textContent.trim();
    if (name) {
      repoOriginals.push(name);
      el.textContent = anonRepo(name);
    }
  });

  // Author spans
  document.querySelectorAll('.author').forEach(function(el) {
    var name = el.textContent.replace(/^@/, '').trim();
    el.textContent = '@' + anonUser(name);
  });

  // Branch names
  document.querySelectorAll('.branch-name').forEach(function(el) {
    el.textContent = anonUser('dev') + '/feature-' + Math.floor(Math.random() * 900 + 100);
  });

  // Checkout commands
  document.querySelectorAll('.checkout-cmd').forEach(function(el) {
    if (el.getAttribute('data-cmd')) {
      el.setAttribute('data-cmd', 'cd ~/project && git fetch origin branch && git checkout branch');
    }
  });

  // Replace @mentions and known usernames/repos in any text
  function anonymizeText(text) {
    // Replace @mentions
    text = text.replace(/@[\w-]+/g, function(match) {
      return '@' + anonUser(match.slice(1));
    });
    // Replace known repo names
    repoOriginals.forEach(function(name) {
      text = text.split(name).join(repoMap[name]);
    });
    return text;
  }

  // Status text
  document.querySelectorAll('.status-text').forEach(function(el) {
    el.textContent = anonymizeText(el.textContent);
  });

  // Neutralize URLs
  document.querySelectorAll('.title-col a').forEach(function(el) {
    el.href = '#';
  });

  // Clear prompt data
  document.querySelectorAll('.ai-log, .prompt-tooltip').forEach(function(el) {
    el.textContent = '';
  });
  document.querySelectorAll('.copy-prompt').forEach(function(el) {
    el.style.display = 'none';
  });

  // Keep max 3 rows per category, remove the rest
  document.querySelectorAll('tbody').forEach(function(tbody) {
    var rows = tbody.querySelectorAll('tr');
    for (var i = 3; i < rows.length; i++) {
      rows[i].remove();
    }
  });

  // Update section counts in headings
  document.querySelectorAll('h2').forEach(function(h2) {
    var table = h2.nextElementSibling;
    while (table && table.tagName !== 'TABLE') table = table.nextElementSibling;
    if (table) {
      var count = table.querySelectorAll('tbody tr').length;
      h2.textContent = h2.textContent.replace(/\(\d+\)/, '(' + count + ')');
    }
  });

  // Page title
  document.title = 'GitHub Status - Demo';
  var h1 = document.querySelector('h1');
  if (h1) h1.childNodes[0].textContent = 'GitHub Status - Demo ';

  console.log('Anonymized. Repos:', repoMap, 'Users:', userMap);
})();
