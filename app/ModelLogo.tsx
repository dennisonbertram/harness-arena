// Brand logomarks (official assets, single-path/single-color) for the
// providers behind our models, keyed by the gateway id's provider prefix.
// Anthropic and Z.ai marks are Simple Icons' (simpleicons.org, CC0) path
// data; Poolside's is their own official press-kit logomark
// (poolside.ai/brand/Poolside-logomark.zip, "solid" variant). Rendered with
// our own theme-aware fill rather than each source's embedded color.
const PROVIDER_LOGOS: Record<string, { viewBox: string; path: string }> = {
  anthropic: {
    viewBox: "0 0 24 24",
    path: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  },
  zai: {
    viewBox: "0 0 24 24",
    path: "M12.606 1.806l-1.677 2.388c-0.258 0.374-0.697 0.606-1.161 0.606h-9.162V1.794C0.594 1.806 12.606 1.806 12.606 1.806zM24 1.806L9.6 22.206 0 22.206 14.4 1.806zM11.394 22.206l1.69-2.4c0.258-0.374 0.697-0.606 1.161-0.606h9.149v3.006H11.394z",
  },
  poolside: {
    viewBox: "0 0 128 128",
    path: "m35.959 121.526c-11.8772-5.794-21.5249-14.947-27.90834-26.4686-6.23593-11.2582-8.930092-23.9574-7.798832-36.7265.256124-2.8615 2.777032-4.9741 5.639732-4.7214 2.85734.2545 4.97334 2.7778 4.72074 5.641-.94779 10.6955 1.3128 21.3362 6.538 30.7705 4.4985 8.1229 10.9417 14.84 18.8061 19.656l24.4606-50.1633c-9.5744-3.1888-17.5492-1.8007-18.2669-1.6613-.1053.0243-.2071.0414-.3106.0621-2.3841.3992-4.6901-.9038-5.6184-3.0702-1.2811-2.3919-5.1275-8.2384-9.7828-10.5094-4.6552-2.2711-11.8298-1.5385-14.1394-1.0363-1.9474.4252-3.97402-.3009-5.20405-1.8667-1.23003-1.5659-1.4658-3.7015-.5927-5.492 15.45775-31.71872 53.84575-44.93849 85.55925-29.46724 31.7136 15.47124 44.9196 53.82984 29.4886 85.53934-.016.0323-.032.0647-.049.1006-15.485 31.6834-53.8429 44.8774-85.542 29.4134zm33.8009-57.4544-24.4588 50.1594c24.6863 9.222 52.7773-1.024 65.6229-24.3097-1.806-2.7947-4.974-6.8014-8.641-8.5902-4.7375-2.3114-11.6793-1.5543-14.0641-1.0532-.3926.0933-.7839.1383-1.1773.1422-.7048.0034-1.4199-.1363-2.1061-.4355-.7114-.3114-1.3547-.781-1.874-1.386-.2968-.3495-.5421-.7317-.7393-1.1395-.1533-.3062-3.9466-7.6667-12.5659-13.3893zm-38.7651-29.0902c3.9831 1.9431 7.2244 5.0332 9.6483 7.947 7.496-11.4666 17.6688-20.1275 25.527-25.7116 2.9201-2.0736 5.9436-4.0123 8.8552-5.6852-20.4537-4.29467-41.8903 3.8115-54.3197 20.8782 3.2899.2252 6.9209.9284 10.2892 2.5716zm67.5712-11.9611c.4747 3.3248.8105 6.8979.9729 10.4798.4384 9.6049-.1169 22.9086-4.5038 35.8475 3.6589.0981 7.9139.7451 11.8069 2.6443 3.476 1.6959 6.39 4.2614 8.684 6.8223 5.855-20.3405-.95-42.2864-16.9617-55.7903zm-28.7702 29.1142c7.1932 3.5091 12.3927 8.1776 15.9169 12.2023 5.733-18.6289 3.2338-39.4757 1.1469-47.1965-7.3675 3.1085-25.3335 13.9715-36.4767 29.961 5.3459.2981 12.2232 1.5257 19.4129 5.0332z",
  },
};

// A baseline row has no submitter to show an avatar for, so it shows the
// model's provider logo instead -- same circular badge as GithubAvatar's
// placeholder, with the provider's real logomark in place of "?".
export function ModelLogo({ model, size = 24 }: { model: string; size?: number }) {
  const provider = model.split("/")[0];
  const logo = PROVIDER_LOGOS[provider];
  const badgeStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    verticalAlign: "middle",
    marginRight: 8,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--gray-alpha-400)",
    flexShrink: 0,
  };

  if (!logo) {
    return (
      <span aria-hidden="true" style={{ ...badgeStyle, color: "var(--gray-700)", fontSize: Math.round(size * 0.46) }}>
        ?
      </span>
    );
  }
  return (
    <span aria-hidden="true" style={badgeStyle}>
      <svg viewBox={logo.viewBox} width={Math.round(size * 0.58)} height={Math.round(size * 0.58)}>
        <path d={logo.path} fill="var(--gray-1000)" />
      </svg>
    </span>
  );
}
