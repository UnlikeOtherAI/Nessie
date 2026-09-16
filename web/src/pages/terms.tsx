// The prose of /terms. The title, the lede, the route and every link to this
// page come from `registry.ts`; this file starts at <h2> and says nothing the
// repository cannot back up. Anything we cannot establish is an
// `n-placeholder` — a visible dashed gap — rather than plausible boilerplate.
export const TermsPage = () => (
  <>
    <p>
      <strong>This is a draft.</strong> It describes how Nessie actually works today, but it has not been reviewed
      by a lawyer and Nessie has not launched. Treat it as a statement of intent, not as a finished contract.
    </p>

    <h2>1. Who you are agreeing with</h2>
    <p>
      Nessie is made by <strong>UnlikeOtherAI s.r.o.</strong>, a company registered in the Czech Republic. In these
      terms, “we” and “us” mean that company, and “you” means the person or organisation using Nessie.
    </p>
    <p className="n-placeholder">
      Missing: the company registration number (IČO) and the registered office address.
    </p>
    <p className="n-placeholder">
      Missing: the VAT number, if the company is VAT registered.
    </p>
    <p className="n-placeholder">
      Missing: the effective date of these terms.
    </p>

    <h2>2. Two different relationships</h2>
    <p>
      There are two separate ways to use Nessie, and they are governed by different things. Read the part that
      applies to you. If you do both, both apply.
    </p>
    <ul>
      <li>
        <strong>Nessie Cloud</strong> — we run Nessie for you, you pay us a monthly fee, and sections 4 to 13
        apply.
      </li>
      <li>
        <strong>The source code</strong> — you download Nessie and run it on your own infrastructure. Your rights
        come from the licence in section 3, not from a contract with us, and you owe us nothing.
      </li>
    </ul>

    <h2>3. Using the source code</h2>
    <p>
      Nessie’s source code is published under the <strong>Functional Source License, Version 1.1, Apache 2.0
      Future License</strong> (FSL-1.1-ALv2). The licence text is the agreement; this section summarises it and
      does not replace it.
    </p>

    <h3>What the licence allows</h3>
    <ul>
      <li>
        <strong>Self-hosting is free</strong>, including commercial and internal business use, by an organisation
        of any size. You do not need to pay us or ask us.
      </li>
      <li>You may read, modify, fork and redistribute the code.</li>
      <li>You may use it for non-commercial education and non-commercial research.</li>
      <li>
        You may use it while providing professional services — integration, support, customisation — to someone
        else who is running Nessie under this licence.
      </li>
    </ul>

    <h3>What the licence does not allow</h3>
    <p>
      The one restriction is <strong>Competing Use</strong>. You may not take a current release and make it
      available to others in a commercial product or service that substitutes for Nessie, substitutes for another
      product or service we offer using this code, or offers substantially the same functionality. Running a paid,
      multi-tenant hosted Nessie for other people is the clearest example.
    </p>
    <p>
      If you redistribute copies, modifications or derivatives, you must include these licence terms or a link to
      them, and you must not remove copyright notices. The licence gives you no right to use our trade marks,
      trade names or product names, beyond identifying us as the origin of the software.
    </p>

    <h3>Every release becomes Apache 2.0 after two years</h3>
    <p>
      Each release is additionally licensed to you under the <strong>Apache License, Version 2.0</strong>, and
      that grant takes effect on the second anniversary of the date we made that release available. It is
      irrevocable. From that date the Competing Use restriction no longer applies to that release. We keep
      publishing newer releases under FSL, so code that is two years old is always permissively licensed open
      source, while the currently shipping product is not.
    </p>

    <h3>Contributions</h3>
    <p>
      Contributions to the repository are licensed on the same terms as the rest of the code, on the same
      two-year path to Apache 2.0. If you are contributing on behalf of an organisation other than UnlikeOtherAI,
      or the contribution is substantial, we may ask you to sign a separate contributor agreement before we merge
      it.
    </p>

    <h2>4. Nessie Cloud: accounts and signing in</h2>
    <p>
      Nessie Cloud has no passwords of its own. You sign in through <strong>UnlikeOtherAI SSO</strong>, which is
      the authority for who you are, which organisation you belong to and which teams you are in. Your account,
      your profile and your organisation’s membership are created and changed there, not in Nessie.
    </p>
    <p>
      That has three practical consequences. Your administrators in UnlikeOtherAI control who can reach your
      Nessie tenant. Removing somebody there removes their access here. And if you close your UnlikeOtherAI
      account, you lose access to Nessie Cloud with it.
    </p>
    <p>
      You are responsible for what happens under your organisation’s accounts. Tell us at{' '}
      <a href="mailto:hello@nessie.works">hello@nessie.works</a> if you believe an account has been misused.
    </p>

    <h2>5. Acceptable use</h2>
    <p>However you use Nessie, do not:</p>
    <ul>
      <li>break the law with it, or use it to help somebody else break the law;</li>
      <li>
        use it to harass, defraud, impersonate or harm people — including by having an agent send email that
        pretends to be somebody it is not;
      </li>
      <li>
        attempt to reach another customer’s data, break out of your tenant, or interfere with the isolation
        between organisations;
      </li>
      <li>connect a mailbox, a calendar, an MCP server or any other account you are not authorised to connect;</li>
      <li>point an agent’s tools at infrastructure you do not control in order to attack or overload it;</li>
      <li>resell or rebrand Nessie Cloud, or use it as the backend of a competing product (see section 3).</li>
    </ul>
    <p>
      Nessie tries to keep credentials out of conversations: a scanner refuses messages that look like they
      contain a secret, and offers to store the value in a vault instead. That is a safety net, not a guarantee.
      Keeping credentials out of chat is still your responsibility.
    </p>

    <h2>6. Fees, billing and tax</h2>
    <p>Nessie Cloud is billed monthly. The published prices are:</p>
    <table>
      <thead>
        <tr>
          <th>What</th>
          <th>Price</th>
          <th>How it is counted</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>People</td>
          <td>€3 per user / month</td>
          <td>Per human user in your organisation.</td>
        </tr>
        <tr>
          <td>Storage</td>
          <td>€10 per TB / month</td>
          <td>One bill for the whole team. It is never multiplied by the number of users.</td>
        </tr>
        <tr>
          <td>AI employees</td>
          <td>No seat charge</td>
          <td>Agents do not take a seat, however many you create.</td>
        </tr>
        <tr>
          <td>Inference</td>
          <td>Per token</td>
          <td>Charged only when an agent runs on models we provide.</td>
        </tr>
      </tbody>
    </table>
    <p>
      <strong>You can bring your own AI accounts.</strong> If you connect AI accounts you already pay for —
      including subscriptions — your agents run on them and we add no charge for that inference. You pay your
      provider directly, on their terms. If you use the models we provide instead, we bill per token.
    </p>
    <p>
      Nessie records every model call in a token-cost ledger: the provider, the model, the token counts and an
      estimated cost, broken down by organisation, team, project, channel, agent and person. That ledger is what
      usage charges are based on, and you can see it.
    </p>
    <p>
      Billing itself sits in UnlikeOtherAI rather than inside Nessie. Your statement, your subscription and your
      payment details live there, and card payments are processed by Stripe. Nessie holds no card details, no
      subscription and no invoice of its own.
    </p>
    <p className="n-placeholder">
      Missing: whether prices are stated excluding VAT, how VAT applies to customers inside and outside the Czech
      Republic, and how the reverse charge is handled for EU business customers.
    </p>
    <p className="n-placeholder">
      Missing: payment terms — when an invoice falls due, what happens if it is not paid, whether there is a
      refund or a pro-rata credit when you remove users mid-month, and how much notice we give before a price
      change.
    </p>

    <h2>7. Your data, and who owns it</h2>
    <p>
      <strong>Your content stays yours.</strong> Messages, files, documents, tasks, agent configuration and
      everything else you put into Nessie belong to you. We do not claim ownership of it, and we do not sell it.
    </p>
    <p>
      We process it in order to run the service: to store and deliver it, to send it to the model provider your
      deployment is configured with when an agent runs, to index it so agents and search can find it, and to keep
      the audit trail and the cost ledger the product is built around. What happens to personal data, and who
      else touches it, is set out in the <a href="/privacy">privacy policy</a>.
    </p>
    <p>If you self-host, we hold none of it. It is on your infrastructure and we never see it.</p>
    <p className="n-placeholder">
      Missing: a data processing agreement (DPA) for Nessie Cloud customers, which EU business customers will ask
      for before signing. There is no published DPA yet.
    </p>

    <h2>8. AI employees, and what you are responsible for</h2>
    <p>
      Nessie’s agents are software. They are not people, not employees and not professional advisers. They produce
      output by asking a language model, which means the output can be wrong, incomplete or invented — and wrong
      in a way that reads as confident.
    </p>
    <p>
      <strong>You are responsible for what your agents do.</strong> You decide which agents exist, what they can
      reach, which tools they hold, which mailboxes they can use, and what runs without a person looking at it
      first. Nessie gives you approval gates that hold consequential actions until somebody accepts them, an audit
      trail of what each agent did and what was refused, and per-agent scoping so an agent sees only the channels,
      projects and documents you gave it. Whether you switch those protections on, and where you set the line, is
      your decision.
    </p>
    <p>
      Agents can send email from a real address, reply in a mailbox you connected, call external tools and act on
      other systems. When they do, that is your organisation acting. Do not use agent output for anything legal,
      medical, financial or safety-critical without a qualified person checking it.
    </p>

    <h2>9. Availability and support</h2>
    <p>
      We want Nessie Cloud to be reliable, and we would rather tell you what we do not promise than promise
      something we cannot keep.
    </p>
    <ul>
      <li><strong>There is no uptime commitment.</strong> We publish no SLA and we owe no service credits.</li>
      <li>
        We deploy changes to Nessie Cloud continuously. We may change, add or remove features, and something you
        rely on may work differently after an update.
      </li>
      <li>
        Parts of Nessie depend on services we do not run — model providers, mail providers, browser and search
        providers, identity. When one of those is down or refuses a request, that part of Nessie stops working,
        and we cannot fix it for you.
      </li>
      <li>Support is by email at <a href="mailto:hello@nessie.works">hello@nessie.works</a>.</li>
    </ul>
    <p className="n-placeholder">
      Missing: support hours, target response times, any maintenance window, and whether a paid support or SLA
      tier will exist.
    </p>

    <h2>10. Warranties</h2>
    <p>
      The source code is provided “as is” and without warranties of any kind, express or implied, including
      warranties of fitness for a particular purpose, merchantability, title and non-infringement. That is the
      licence’s own disclaimer, and it applies to anyone running Nessie themselves.
    </p>
    <p>
      For Nessie Cloud we provide the service with reasonable skill and care. Beyond that, and so far as the law
      allows, we give no warranty: not that the service will be uninterrupted or error-free, not that it will meet
      your requirements, and not that anything an AI model produces through it will be accurate.
    </p>

    <h2>11. Liability</h2>
    <p>
      Nothing here limits liability that cannot be limited by law — including liability for death or personal
      injury caused by negligence, and for fraud.
    </p>
    <p>
      Subject to that, and so far as the law allows, we are not liable for indirect, special, incidental or
      consequential loss, for lost profits, lost revenue or lost business, or for loss or corruption of data, even
      if we were told the loss was possible. For anyone using the source code, the licence excludes our liability
      entirely.
    </p>
    <p className="n-placeholder">
      Missing: the cap on our total liability to a Nessie Cloud customer. This needs a specific figure or formula
      — a common one is the fees paid in the twelve months before the claim — and we will not invent one here.
    </p>

    <h2>12. Termination</h2>
    <p>
      You can stop using Nessie Cloud at any time by cancelling your subscription. We can suspend or end your
      access if you breach these terms, if fees go unpaid, or if the law requires it. Where it is reasonable to do
      so, we will tell you first and give you a chance to put it right.
    </p>
    <p>
      If we stop offering Nessie Cloud altogether, we will give you notice and a period in which to get your data
      out. Ending your subscription does not affect your rights under the source licence, which continues on its
      own terms.
    </p>
    <p className="n-placeholder">
      Missing: a stated period after termination during which we keep your data available for export, and the
      point at which it is deleted. There is no self-service export and no self-service deletion in the product
      today — both are done by hand on request — so no dated contract can honestly be published yet.
    </p>

    <h2>13. Changes to these terms</h2>
    <p>
      We may update these terms. When a change materially affects Nessie Cloud customers, we will tell you before
      it takes effect, and the updated version will be published on this page with its date. If you do not accept
      a change, your remedy is to stop using Nessie Cloud and cancel.
    </p>
    <p className="n-placeholder">
      Missing: how much notice we give before a material change takes effect, and whether notice is by email or
      only by publishing here.
    </p>

    <h2>14. Governing law and jurisdiction</h2>
    <p>
      These terms are governed by the law of the <strong>Czech Republic</strong>, and the courts of the Czech
      Republic have exclusive jurisdiction over any dispute arising from them or from your use of Nessie. If you
      are a consumer, this does not remove any protection you have under the mandatory law of the country you
      live in.
    </p>
    <p>If any part of these terms is found unenforceable, the rest stays in force.</p>

    <h2>15. Contact</h2>
    <p>
      Write to <a href="mailto:hello@nessie.works">hello@nessie.works</a> about anything on this page.
    </p>
  </>
)
