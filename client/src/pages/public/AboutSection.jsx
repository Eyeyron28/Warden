import { Link } from 'react-router-dom';

import Reveal from '../../components/site/Reveal.jsx';
import { PROJECT } from '../../config.js';
import { LIMITS } from './limits.js';
import site from '../../components/site/site.module.css';
import styles from './AboutSection.module.css';

// ---- Edit the team here ----
// Placeholder names and roles. Replace each entry with a real member;
// the page renders whatever is in this array, in this order.
const TEAM = [
  { name: 'Member One', role: 'Project lead, backend' },
  { name: 'Member Two', role: 'Cryptography and security review' },
  { name: 'Member Three', role: 'Frontend and design' },
  { name: 'Member Four', role: 'Testing and documentation' },
];

const DESIGN_POINTS = [
  {
    title: 'One random key per vault',
    body: 'Each account gets its own 256-bit key at signup. Every file is encrypted with it using AES-256-GCM, which also refuses to decrypt a file that has been altered.',
  },
  {
    title: 'The key is never stored in the open',
    body: 'It is saved twice, each copy locked: once with a key derived from your password (scrypt), once with a key derived from your recovery key. Your password itself is never stored, only a salted hash used to check it.',
  },
  {
    title: 'Sessions hold the key only while you use it',
    body: 'When you log in, your unlocked key is locked again for your session with a random key that exists only in your session token. The token is kept in browser memory, so reloading the page signs you out. The server unlocks the key for each request. Logging out deletes the session, and sessions expire after 30 minutes without activity.',
  },
  {
    title: 'Recovery is checked before anything changes',
    body: 'A password reset with your recovery key, or approved from your paired phone, proves it unlocks your exact vault before any password or key is rewritten.',
  },
];

/**
 * The "About" part of the one-page landing site (Home -> About -> Contact):
 * why the project exists, how its security works in plain words, and the
 * team. Lives at /#about; the old /about route redirects there.
 */
function AboutSection() {
  return (
    <section id="about" className={`${site.container} ${site.sectionRule}`} aria-labelledby="about-title">
      <header className={styles.intro}>
        <p className={site.marker}>About the project</p>
        <h2 id="about-title" className={styles.title}>
          A capstone about keeping documents safe, built to be honest about how.
        </h2>
        <div className={styles.introText}>
          <p>
            Warden is the capstone project of {PROJECT.group}, {PROJECT.program} at {PROJECT.school}, for our{' '}
            {PROJECT.course} (computer security) course.
          </p>
          <p>
            We built it because the documents people most need to keep, like IDs, birth certificates, land titles
            and tax records, usually end up as phone photos or files in a general-purpose drive. Warden is our
            attempt at a vault for exactly those, with security claims you can check against the code, and a plain
            list of what it does not protect against.
          </p>
        </div>
      </header>

      <section className={`${site.section} ${site.sectionRule}`} aria-labelledby="design-title">
        <div className={styles.designGrid}>
          <Reveal>
            <p className={site.marker}>
              <span className={site.markerNumber}>01</span> Security design
            </p>
            <h3 id="design-title" className={site.sectionTitle}>
              The design, in plain words.
            </h3>
            <p className={site.lede}>
              For the step-by-step version, see{' '}
              <Link to="/#how-it-works" className={site.textLink}>
                how it works
              </Link>
              .
            </p>
          </Reveal>
          <Reveal as="ol" className={styles.designList}>
            {DESIGN_POINTS.map((point) => (
              <li key={point.title}>
                <h3>{point.title}</h3>
                <p>{point.body}</p>
              </li>
            ))}
          </Reveal>
        </div>
      </section>

      <section id="limits" className={`${site.section} ${site.sectionRule}`} aria-labelledby="limits-title">
        <div className={styles.designGrid}>
          <Reveal>
            <p className={site.marker}>
              <span className={site.markerNumber}>02</span> Limits
            </p>
            <h3 id="limits-title" className={site.sectionTitle}>
              What Warden does not protect against.
            </h3>
            <p className={site.lede}>
              Warden is not end-to-end encrypted, and some risks sit outside what encryption can do.
            </p>
          </Reveal>
          <Reveal as="ul" className={styles.designList}>
            {LIMITS.map((item) => (
              <li key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </li>
            ))}
          </Reveal>
        </div>
      </section>

      <section className={`${site.section} ${site.sectionRule}`} aria-labelledby="team-title">
        <Reveal>
          <p className={site.marker}>
            <span className={site.markerNumber}>03</span> Team
          </p>
          <h3 id="team-title" className={site.sectionTitle}>
            {PROJECT.group}
          </h3>
        </Reveal>
        <Reveal as="ul" className={styles.team}>
          {TEAM.map((member) => (
            <li key={member.name} className={styles.member}>
              <span className={styles.initials} aria-hidden="true">
                {member.name
                  .split(' ')
                  .map((part) => part[0])
                  .join('')
                  .slice(0, 2)}
              </span>
              <span>
                <span className={styles.memberName}>{member.name}</span>
                <span className={styles.memberRole}>{member.role}</span>
              </span>
            </li>
          ))}
        </Reveal>
      </section>
    </section>
  );
}

export default AboutSection;
