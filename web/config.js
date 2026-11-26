// Valores públicos por diseño (la clave publishable/anon solo da lo que permiten RLS y la función).
export const SUPABASE_URL = "https://rnhweshphzktvjvgzglz.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_r7oHJLUTOJgSaJlqzCCKkA_Th5X47CF";

// Solo desarrollo: ?mock=http://127.0.0.1:8020 salta el login y usa un servidor local.
export const MOCK_API = new URLSearchParams(location.search).get("mock");
