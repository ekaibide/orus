// Valores públicos por diseño (la clave publishable/anon solo da lo que permiten RLS y la función).
// Se rellenan al crear el proyecto de Supabase.
export const SUPABASE_URL = "https://TU-PROYECTO.supabase.co";
export const SUPABASE_ANON_KEY = "TU-CLAVE-PUBLISHABLE";

// Solo desarrollo: ?mock=http://127.0.0.1:8020 salta el login y usa un servidor local.
export const MOCK_API = new URLSearchParams(location.search).get("mock");
