// Seed master user, courses, and demo students. Idempotent.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MASTER_EMAIL = "andres_dfx@hotmail.com";
const MASTER_PASSWORD = "Tester#12345";
const MASTER_NAME = "Andrés (Master)";

const COURSES = ["Trabajo Integrador I", "Programación II", "Bases de Datos"];

const DEMO_STUDENTS = [
  {
    full_name: "María Pérez",
    institutional_email: "maria.perez@institucion.edu",
    personal_email: "maria.perez@gmail.com",
  },
  {
    full_name: "Juan García",
    institutional_email: "juan.garcia@institucion.edu",
    personal_email: "juan.garcia@gmail.com",
  },
  {
    full_name: "Lucía Torres",
    institutional_email: "lucia.torres@institucion.edu",
    personal_email: "lucia.torres@gmail.com",
  },
  {
    full_name: "Carlos Ruiz",
    institutional_email: "carlos.ruiz@institucion.edu",
    personal_email: "carlos.ruiz@gmail.com",
  },
  {
    full_name: "Ana Morales",
    institutional_email: "ana.morales@institucion.edu",
    personal_email: "ana.morales@gmail.com",
  },
];

const DEMO_PASSWORD = "Estudiante#123";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const log: string[] = [];

    // Helper: ensure user exists
    async function ensureUser(
      email: string,
      password: string,
      full_name: string,
      personal_email: string | null,
    ) {
      const { data: list } = await supabase.auth.admin.listUsers();
      const existing = list?.users?.find((u: any) => u.email === email);
      if (existing) {
        log.push(`✓ user exists: ${email}`);
        return existing.id;
      }
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name, institutional_email: email, personal_email },
      });
      if (error) throw new Error(`createUser ${email}: ${error.message}`);
      log.push(`+ user created: ${email}`);
      return data.user!.id;
    }

    async function ensureRole(user_id: string, role: "Admin" | "Docente" | "Estudiante") {
      const { error } = await supabase
        .from("user_roles")
        .upsert({ user_id, role }, { onConflict: "user_id,role" });
      if (error) throw new Error(`role ${role}: ${error.message}`);
    }

    // Master user with all 3 roles
    const masterId = await ensureUser(MASTER_EMAIL, MASTER_PASSWORD, MASTER_NAME, MASTER_EMAIL);
    await ensureRole(masterId, "Admin");
    await ensureRole(masterId, "Docente");
    await ensureRole(masterId, "Estudiante");
    log.push(`✓ master roles assigned`);

    // Courses
    const courseIds: Record<string, string> = {};
    for (const name of COURSES) {
      const { data: existing } = await supabase
        .from("courses")
        .select("id")
        .eq("name", name)
        .maybeSingle();
      if (existing) {
        courseIds[name] = existing.id;
        log.push(`✓ course exists: ${name}`);
      } else {
        const { data, error } = await supabase
          .from("courses")
          .insert({ name })
          .select("id")
          .single();
        if (error) throw error;
        courseIds[name] = data.id;
        log.push(`+ course created: ${name}`);
      }
    }

    // Demo students
    const studentIds: string[] = [];
    for (const s of DEMO_STUDENTS) {
      const id = await ensureUser(
        s.institutional_email,
        DEMO_PASSWORD,
        s.full_name,
        s.personal_email,
      );
      await ensureRole(id, "Estudiante");
      studentIds.push(id);
    }

    // Enroll all students + master in all courses
    for (const cid of Object.values(courseIds)) {
      for (const uid of [masterId, ...studentIds]) {
        await supabase
          .from("course_enrollments")
          .upsert({ course_id: cid, user_id: uid }, { onConflict: "course_id,user_id" });
      }
    }
    log.push(`✓ enrollments synced`);

    return new Response(
      JSON.stringify({ ok: true, log, masterEmail: MASTER_EMAIL, demoPassword: DEMO_PASSWORD }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
