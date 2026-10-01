/* ===========================================================
   supabase-config.js — Conexión al servidor (Supabase)
   Estos dos valores NO son secretos: la "anon key" está pensada
   para viajar en el navegador de cada usuario. La seguridad real
   la hacen las políticas de permisos (RLS) configuradas del lado
   del servidor, no el hecho de que esta clave sea privada.
   =========================================================== */

const SUPABASE_URL = "https://xtnvirfkhhguawqnufbu.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_3HAucYw5R4N2DwdCi-LiGA_X0227gvN";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
