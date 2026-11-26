import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const ContentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://apis.google.com https://*.firebaseapp.com https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "worker-src 'self'",
  "form-action 'self'",
  "connect-src 'self' https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com https://*.googleapis.com https://*.firebaseapp.com https://firebasestorage.googleapis.com https://content-firebaseappcheck.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/",
  "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com https://www.google.com/recaptcha/",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: ContentSecurityPolicy },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=()" },
        ],
      },
      ...(isDev
        ? []
        : [
            {
              source: "/_next/static/:path*",
              headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
            },
          ]),
    ];
  },
};

export default nextConfig;
