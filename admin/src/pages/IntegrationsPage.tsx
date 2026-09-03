import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { IntegratedProductResponse } from '../lib/api-client'
import {
  AgentConnectorSection,
  appsHref,
  mcpConnectorLabel,
  mcpConnectorTone,
} from '../components/features/integrations/AgentConnectorSection'
import { Notice } from '../components/primitives/Notice'
import { Pill, type PillTone } from '../components/primitives/Pill'
import { Switch } from '../components/primitives/Switch'
import { BuildMeProjectPanel } from '../components/features/integrations/BuildMeProjectPanel'
import { DeepTestSecurityPanel } from '../components/features/integrations/DeepTestSecurityPanel'
import { DeepWaterResearchPanel } from '../components/features/integrations/DeepWaterResearchPanel'
import { ExternalAgentActivationSection } from '../components/features/integrations/ExternalAgentActivationSection'
import { ProductSurfacesPanel } from '../components/features/integrations/ProductSurfacesPanel'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { useIsOwner } from '../components/shared/OwnerGate'
import { KeyValueList } from '../components/shared/KeyValueList'
import { QueryState } from '../components/shared/QueryState'
import { StatGrid, StatTile } from '../components/shared/StatTile'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import {
  useIntegratedProducts,
  useIntegrationPluginManifest,
  useSetProductTeamEnablement,
} from '../facades/integrations/hooks'
import { usePhoneLayout } from '../lib/mobile-shell'
import { PhoneNavigationButton } from '../layouts/admin-shell/PhoneNavigationButton'
import { IdentityTile } from '../components/primitives/IdentityTile'

type SurfacePlan = {
  nativePage: string
  chatCards: string
  controls: string
  agentAccess: string
  artifacts: string
  nextStep: string
}

const surfacePlans: Record<string, SurfacePlan> = {
  'deep-water': {
    nativePage: 'Research team with runs, source review, and Knowledge import.',
    chatCards: 'Progress, result, and source cards rendered from message metadata.',
    controls: 'Depth, chapter detail, search quality, recency, output language, and artifact destination.',
    agentAccess: 'Approved MCP tools for create, poll, list, and research scoping conversations.',
    artifacts: 'Reports and evidence land in Knowledge; file blobs go through FileService.',
    nextStep: 'Configure the dedicated Ledger app key, enable the team, and grant the approved tools.',
  },
  deeptest: {
    nativePage: 'Link-out plus local runner status, safe report history, and review profile state.',
    chatCards: 'Security review summary cards with content-minimized status and report links.',
    controls: 'Review profile, local runner target, share-safe import, and disclosure boundary.',
    agentAccess: 'Approved MCP wrapper around deeptest_review and safe status/report retrieval.',
    artifacts: 'Share-safe reports can enter Knowledge; raw target material stays local by default.',
    nextStep: 'Install the local MCP runner, approve safe tools, and preserve the privacy boundary.',
  },
  buildme: {
    nativePage: 'Link-out now; project-board source pairing later once BuildMe exposes board APIs.',
    chatCards: 'Project handoff and board sync cards once external board IDs are paired.',
    controls: 'Column mapping, assignee mapping, sync mode, and conflict policy.',
    agentAccess: 'MCP/API connector after the BuildMe project-board contract is published.',
    artifacts: 'Project specs can link into Nessie project docs without duplicating board state.',
    nextStep: 'Define and ship the BuildMe board API before native board rendering.',
  },
  deepsignal: {
    nativePage: 'Per-user private DeepSignal channel plus a live insight digest page.',
    chatCards: 'Conversation activity and insight cards rendered from message metadata.',
    controls: 'Activate for me using your existing Nessie SSO identity, or deactivate.',
    agentAccess: 'DeepSignal MCP chat, history, and insight tools use Nessie’s app key plus delegated UOA identity.',
    artifacts: 'DeepWater research references deep-link out; DeepSignal owns the report content.',
    nextStep: 'Configure the DeepSignal-issued Nessie app key and activate team access.',
  },
}

const categoryLabels: Record<IntegratedProductResponse['category'], string> = {
  development: 'Development',
  project_management: 'Project management',
  research: 'Research',
  security: 'Security',
}

const installLabels: Record<IntegratedProductResponse['defaultInstallState'], string> = {
  installable: 'Installable',
  link_only: 'Link only',
  native: 'Native',
}

const healthLabels: Record<IntegratedProductResponse['healthStatus'], string> = {
  degraded: 'Degraded',
  healthy: 'Healthy',
  setup_required: 'Setup required',
  unknown: 'Unknown',
  unreachable: 'Unreachable',
}

const healthTone = (status: IntegratedProductResponse['healthStatus']): PillTone => {
  if (status === 'healthy') return 'success'
  if (status === 'degraded' || status === 'setup_required') return 'warning'
  if (status === 'unreachable') return 'danger'
  return 'muted'
}

/**
 * The glyph's fill, as tokens. Each product still reads as its own colour —
 * that is the whole job of a glyph beside a name — but the four raw hex
 * literals this used to carry (`#0f766e`, `#991b1b`, `#4338ca`, `#475569`)
 * answered to no theme: a person on the contrast or the parchment theme saw
 * the exact same teal regardless. There is no categorical brand palette in
 * the token system, so this reuses the nearest semantic tokens instead —
 * `info` for research, `danger` for a security product, `accent-strong` (a
 * second, darker step from `deepsignal`'s own `accent`) for the project-
 * management product, and `tx3` for anything not named here.
 */
const productAccentClass = (slug: string): string => {
  if (slug === 'deep-water') return 'bg-[color:var(--info)]'
  if (slug === 'deeptest') return 'bg-[color:var(--danger)]'
  if (slug === 'buildme') return 'bg-[color:var(--accent-strong)]'
  if (slug === 'deepsignal') return 'bg-[color:var(--accent)]'
  return 'bg-[color:var(--tx3)]'
}

const ProductGlyph = ({ product }: { product: IntegratedProductResponse }) => (
  <IdentityTile
    className={productAccentClass(product.slug)}
    color="var(--on-accent)"
    fallback={{ kind: 'initials', text: product.name.slice(0, 2).toUpperCase() }}
    imageUrl={null}
    label={product.name}
    size={40}
  />
)

const LaunchIcon = () => (
  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const accountLabel = (product: IntegratedProductResponse): string => {
  if (product.accountLink?.status === 'linked') return 'Account linked'
  if (product.accountLink?.status === 'error') return 'Account error'
  if (product.accountLink?.status === 'revoked') return 'Revoked'
  if (product.authMode === 'local_mcp') return 'Local runner pending'
  if (product.authMode === 'uoa_sso') return 'UOA link pending'
  return 'Auth setup pending'
}

const teamEnablementLabel = (product: IntegratedProductResponse): string =>
  product.teamEnablement?.enabled ? 'Team enabled' : 'Team disabled'

const teamAuthorityLabel = (product: IntegratedProductResponse): string => {
  if (product.teamEnablement?.authority === 'uoa_connected_products') return 'UOA authority'
  if (product.teamEnablement) return 'Nessie projection'
  return 'Team source pending'
}

const capabilityLabel = (value: string): string =>
  value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

const ProductRow = ({
  active,
  onSelect,
  product,
}: {
  active: boolean
  onSelect: () => void
  product: IntegratedProductResponse
}) => (
  <button
    className={[
      'admin-card w-full p-3 text-left transition',
      active ? 'ring-2 ring-[color:var(--accent)]' : 'hover:bg-[color:var(--overlay-weak)]',
    ].join(' ')}
    onClick={onSelect}
    type="button"
  >
    <div className="flex min-w-0 gap-3">
      <ProductGlyph product={product} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-[color:var(--tx)]">{product.name}</h3>
          <Pill
            className="font-semibold"
            radius="chip"
            size="sm"
            tone={healthTone(product.healthStatus)}
            uppercase={false}
          >
            {healthLabels[product.healthStatus]}
          </Pill>
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[color:var(--tx3)]">{product.summary}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
            {installLabels[product.defaultInstallState]}
          </Pill>
          <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
            {accountLabel(product)}
          </Pill>
          <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
            {teamEnablementLabel(product)}
          </Pill>
          <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
            {teamAuthorityLabel(product)}
          </Pill>
          <Pill radius="chip" size="sm" tone={mcpConnectorTone(product)} uppercase={false}>
            {mcpConnectorLabel(product)}
          </Pill>
        </div>
      </div>
    </div>
  </button>
)

const TeamAccessSection = ({
  isOwner,
  product,
}: {
  isOwner: boolean
  product: IntegratedProductResponse
}) => {
  const setTeamEnablement = useSetProductTeamEnablement()
  const enabled = product.teamEnablement?.enabled ?? false
  const isToggling =
    setTeamEnablement.isPending && setTeamEnablement.variables?.productSlug === product.slug
  const externalTeamId = product.teamEnablement?.externalTeamId ?? product.accountLink?.activeTeamId
  const externalOrgId = product.teamEnablement?.externalOrgId ?? product.accountLink?.activeOrgId

  return (
    <section className="border-t border-[color:var(--sep)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[color:var(--tx)]">Team access</h3>
          <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
            {enabled ? 'Enabled for the active team.' : 'Not enabled for the active team.'}
          </p>
        </div>
        <span className="flex items-center gap-2">
          <span className="text-sm text-[color:var(--tx2)]">
            {isToggling ? 'Saving...' : enabled ? 'Enabled' : 'Disabled'}
          </span>
          <Switch
            checked={enabled}
            disabled={!isOwner || isToggling}
            label={`${enabled ? 'Disable' : 'Enable'} team access for ${product.name}`}
            onChange={() =>
              setTeamEnablement.mutate({
                enabled: !enabled,
                productSlug: product.slug,
              })
            }
          />
        </span>
      </div>
      <StatGrid className="mt-3">
        <StatTile label="Account" value={accountLabel(product)} />
        <StatTile
          label="UOA team"
          value={externalTeamId ? `${externalOrgId ?? 'org'} / ${externalTeamId}` : 'Not projected yet'}
        />
        <StatTile
          className="sm:col-span-2"
          label="Authority"
          value={teamAuthorityLabel(product)}
        />
      </StatGrid>
      {!isOwner ? (
        <p className="mt-2 text-xs text-[color:var(--tx3)]">Owner access required to change team access.</p>
      ) : null}
      {setTeamEnablement.isError ? (
        <Notice className="mt-2" role="alert" size="sm" tone="danger">
          {setTeamEnablement.error instanceof Error
            ? setTeamEnablement.error.message
            : 'Failed to update team access.'}
        </Notice>
      ) : null}
    </section>
  )
}

const ProductDetail = ({
  onBack,
  product,
  showBack,
}: {
  onBack: () => void
  product: IntegratedProductResponse
  showBack: boolean
}) => {
  const manifestQuery = useIntegrationPluginManifest(product.slug)
  const isOwner = useIsOwner()
  const plan = surfacePlans[product.slug] ?? {
    nativePage: 'Custom product page registered from the integration manifest.',
    chatCards: 'Cards rendered from message metadata when agents run product work.',
    controls: 'Product-specific controls declared by the plugin manifest.',
    agentAccess: 'Approved MCP tools exposed through the existing tool registry.',
    artifacts: 'Durable artifacts stored through Knowledge and FileService.',
    nextStep: 'Publish the product manifest and MCP catalog entry.',
  }
  const productDetailSections = (
    <>
      <TeamAccessSection isOwner={isOwner} product={product} />
      <AgentConnectorSection product={product} />
      {product.slug === 'buildme' ? <BuildMeProjectPanel product={product} /> : null}
      {product.slug === 'deeptest' ? <DeepTestSecurityPanel product={product} /> : null}
      <ExternalAgentActivationSection product={product} />

      <section className="border-t border-[color:var(--sep)] pt-4">
        <h3 className="text-sm font-semibold text-[color:var(--tx)]">Interface surfaces</h3>
        <KeyValueList
          className="mt-3"
          items={[
            { label: 'Native page', value: plan.nativePage },
            { label: 'Chat cards', value: plan.chatCards },
            { label: 'Custom controls', value: plan.controls },
            { label: 'Agent access', value: plan.agentAccess },
            { label: 'Artifacts', value: plan.artifacts },
          ]}
          layout="grid"
        />
      </section>

      <ProductSurfacesPanel
        loading={manifestQuery.isLoading}
        manifest={manifestQuery.data}
        product={product}
      />

      <section className="border-t border-[color:var(--sep)] pt-4">
        <h3 className="text-sm font-semibold text-[color:var(--tx)]">Capabilities</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {product.capabilities.map((capability) => (
            <Pill key={capability} radius="chip" size="sm" tone="muted" uppercase={false}>
              {capabilityLabel(capability)}
            </Pill>
          ))}
        </div>
      </section>

      <section className="border-t border-[color:var(--sep)] pt-4">
        <h3 className="text-sm font-semibold text-[color:var(--tx)]">Next step</h3>
        <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
          {product.setupHint ?? plan.nextStep}
        </p>
      </section>
    </>
  )

  return (
    <ColumnBrowserColumn onBack={onBack} showBack={showBack} title={product.name}>
      <div className="grid gap-4">
        <section className="grid gap-3 border-b border-[color:var(--sep)] pb-4">
          <div className="flex items-start gap-3">
            <ProductGlyph product={product} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-[color:var(--tx)]">{product.name}</h2>
                <Pill
                  className="font-semibold"
                  radius="chip"
                  size="sm"
                  tone={healthTone(product.healthStatus)}
                  uppercase={false}
                >
                  {healthLabels[product.healthStatus]}
                </Pill>
              </div>
              <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">{product.summary}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
              {categoryLabels[product.category]}
            </Pill>
            <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
              {installLabels[product.defaultInstallState]}
            </Pill>
            <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
              {accountLabel(product)}
            </Pill>
            <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
              {teamEnablementLabel(product)}
            </Pill>
            <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
              {teamAuthorityLabel(product)}
            </Pill>
            <Pill radius="chip" size="sm" tone={mcpConnectorTone(product)} uppercase={false}>
              {mcpConnectorLabel(product)}
            </Pill>
          </div>
          <div className="flex flex-wrap gap-2">
            {product.launchUrl ? (
              <a
                className="admin-button admin-button-primary admin-button-compact gap-1.5"
                href={product.launchUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open <LaunchIcon />
              </a>
            ) : null}
            {product.mcpCatalogEntryId ? (
              <Link
                className="admin-button admin-button-secondary admin-button-compact"
                to={appsHref(product)}
              >
                Open apps
              </Link>
            ) : null}
          </div>
        </section>

        {product.slug === 'deep-water' ? (
          <DeepWaterResearchPanel product={product} settingsContent={productDetailSections} />
        ) : productDetailSections}
      </div>
    </ColumnBrowserColumn>
  )
}

export const IntegrationsPage = () => {
  const productsQuery = useIntegratedProducts()
  const phoneLayout = usePhoneLayout()
  const [selectedSlug, setSelectedSlug] = useState<string>()
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)

  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data])
  const selectedProduct = useMemo(
    () => products.find((product) => product.slug === selectedSlug) ?? products[0] ?? null,
    [products, selectedSlug],
  )

  const listBody = (
    <QueryState
      emptyLabel="No integrations registered."
      errorLabel="Failed to load integrations."
      isEmpty={products.length === 0}
      loadingLabel="Loading integrations…"
      query={productsQuery}
    >
      {() => (
        <div className="grid gap-3">
          {products.map((product) => (
            <ProductRow
              active={selectedProduct?.slug === product.slug}
              key={product.slug}
              onSelect={() => {
                setSelectedSlug(product.slug)
                setMobileDetailOpen(true)
              }}
              product={product}
            />
          ))}
        </div>
      )}
    </QueryState>
  )

  const columns = [
    <ColumnBrowserColumn
      key="list"
      leading={<PhoneNavigationButton />}
      title={`Integrations (${products.length})`}
    >
      {listBody}
    </ColumnBrowserColumn>,
  ]

  if (selectedProduct) {
    columns.push(
      <ProductDetail
        key={selectedProduct.slug}
        onBack={() => setMobileDetailOpen(false)}
        product={selectedProduct}
        showBack
      />,
    )
  }

  return (
    <ColumnBrowserViewport
      activeColumn={phoneLayout && mobileDetailOpen ? 1 : 0}
      columns={columns}
    />
  )
}
