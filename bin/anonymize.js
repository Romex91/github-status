// Paste into browser console to anonymize the dashboard for screenshots.
// Replaces repo names, usernames, and branch names. Keeps PR titles as-is.
{
  const repoMap = {};
  const userMap = {};
  let repoN = 0;
  let userN = 0;

  const anonRepo = name => {
    if (!repoMap[name]) repoMap[name] = 'project-' + (++repoN);
    return repoMap[name];
  };

  const anonUser = name => {
    if (!userMap[name]) userMap[name] = 'user-' + (++userN);
    return userMap[name];
  };

  // Collect all real usernames first so we can replace them everywhere
  document.querySelectorAll('.author').forEach(el => {
    const name = el.textContent.replace(/^@/, '').trim();
    if (name) anonUser(name);
  });

  // Repo names — collect originals, then replace
  const repoOriginals = [];
  document.querySelectorAll('.repo-col').forEach(el => {
    if (el.tagName === 'TH') return;
    const name = el.textContent.trim();
    if (name) {
      repoOriginals.push(name);
      el.textContent = anonRepo(name);
    }
  });

  // Author spans
  document.querySelectorAll('.author').forEach(el => {
    const name = el.textContent.replace(/^@/, '').trim();
    el.textContent = '@' + anonUser(name);
  });

  // Branch names
  document.querySelectorAll('.branch-name').forEach(el => {
    el.textContent = anonUser('dev') + '/feature-' + Math.floor(Math.random() * 900 + 100);
  });

  // Checkout commands
  document.querySelectorAll('.checkout-cmd').forEach(el => {
    if (el.getAttribute('data-cmd')) {
      el.setAttribute('data-cmd', 'cd ~/project && git fetch origin branch && git checkout branch');
    }
  });

  // Replace @mentions and known usernames/repos in any text
  const anonymizeText = text => {
    text = text.replace(/@[\w-]+/g, mention => '@' + anonUser(mention.slice(1)));
    for (const name of repoOriginals) {
      text = text.split(name).join(repoMap[name]);
    }
    return text;
  };

  // Status text
  document.querySelectorAll('.status-text').forEach(el => {
    el.textContent = anonymizeText(el.textContent);
  });

  // Neutralize URLs
  document.querySelectorAll('.title-col a').forEach(el => { el.href = '#'; });

  // Clear prompt data
  document.querySelectorAll('.ai-log, .prompt-tooltip').forEach(el => { el.textContent = ''; });
  document.querySelectorAll('.copy-prompt').forEach(el => { el.style.display = 'none'; });

  // Keep max 3 rows per category, remove the rest
  document.querySelectorAll('tbody').forEach(tbody => {
    const rows = tbody.querySelectorAll('tr');
    for (let i = 3; i < rows.length; i++) rows[i].remove();
  });

  // Update section counts in headings
  document.querySelectorAll('h2').forEach(heading => {
    let table = heading.nextElementSibling;
    while (table && table.tagName !== 'TABLE') table = table.nextElementSibling;
    if (table) {
      const count = table.querySelectorAll('tbody tr').length;
      heading.textContent = heading.textContent.replace(/\(\d+\)/, '(' + count + ')');
    }
  });

  // Page title
  document.title = 'GitHub Status - Demo';
  const h1 = document.querySelector('h1');
  if (h1) h1.childNodes[0].textContent = 'GitHub Status - Demo ';

  console.log('Anonymized. Repos:', repoMap, 'Users:', userMap);
}
