export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      academic_periods: {
        Row: {
          closed_at: string | null;
          closed_by: string | null;
          code: string;
          created_at: string;
          end_date: string | null;
          id: string;
          name: string | null;
          start_date: string | null;
          status: string;
          tenant_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          closed_at?: string | null;
          closed_by?: string | null;
          code: string;
          created_at?: string;
          end_date?: string | null;
          id?: string;
          name?: string | null;
          start_date?: string | null;
          status?: string;
          tenant_id: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          closed_at?: string | null;
          closed_by?: string | null;
          code?: string;
          created_at?: string;
          end_date?: string | null;
          id?: string;
          name?: string | null;
          start_date?: string | null;
          status?: string;
          tenant_id?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "academic_periods_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      academic_programs: {
        Row: {
          active: boolean;
          code: string | null;
          created_at: string;
          faculty: string | null;
          id: string;
          name: string;
          tenant_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          active?: boolean;
          code?: string | null;
          created_at?: string;
          faculty?: string | null;
          id?: string;
          name: string;
          tenant_id: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          active?: boolean;
          code?: string | null;
          created_at?: string;
          faculty?: string | null;
          id?: string;
          name?: string;
          tenant_id?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "academic_programs_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      academic_subjects: {
        Row: {
          active: boolean;
          bibliografia: string | null;
          code: string | null;
          contenidos: string | null;
          created_at: string;
          credits: number | null;
          description: string | null;
          id: string;
          intensidad_horaria: number | null;
          name: string;
          objetivos: string | null;
          program_id: string | null;
          semestre: number | null;
          sistema_evaluacion: Json | null;
          tenant_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          active?: boolean;
          bibliografia?: string | null;
          code?: string | null;
          contenidos?: string | null;
          created_at?: string;
          credits?: number | null;
          description?: string | null;
          id?: string;
          intensidad_horaria?: number | null;
          name: string;
          objetivos?: string | null;
          program_id?: string | null;
          semestre?: number | null;
          sistema_evaluacion?: Json | null;
          tenant_id: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          active?: boolean;
          bibliografia?: string | null;
          code?: string | null;
          contenidos?: string | null;
          created_at?: string;
          credits?: number | null;
          description?: string | null;
          id?: string;
          intensidad_horaria?: number | null;
          name?: string;
          objetivos?: string | null;
          program_id?: string | null;
          semestre?: number | null;
          sistema_evaluacion?: Json | null;
          tenant_id?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "academic_subjects_program_id_fkey";
            columns: ["program_id"];
            isOneToOne: false;
            referencedRelation: "academic_programs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "academic_subjects_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_grading_queue: {
        Row: {
          acknowledged_at: string | null;
          attempts: number;
          body: Json;
          completed_at: string | null;
          course_id: string | null;
          created_at: string;
          created_by: string | null;
          field_feedback: string;
          field_grade: string;
          field_likelihood: string | null;
          field_reasons: string | null;
          id: string;
          invoke_target: string;
          kind: string;
          last_error: string | null;
          rejected_at: string | null;
          rejected_by: string | null;
          rejection_reason: string | null;
          started_at: string | null;
          status: string;
          target_row_id: string;
          target_table: string;
        };
        Insert: {
          acknowledged_at?: string | null;
          attempts?: number;
          body: Json;
          completed_at?: string | null;
          course_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          field_feedback?: string;
          field_grade?: string;
          field_likelihood?: string | null;
          field_reasons?: string | null;
          id?: string;
          invoke_target?: string;
          kind: string;
          last_error?: string | null;
          rejected_at?: string | null;
          rejected_by?: string | null;
          rejection_reason?: string | null;
          started_at?: string | null;
          status?: string;
          target_row_id: string;
          target_table: string;
        };
        Update: {
          acknowledged_at?: string | null;
          attempts?: number;
          body?: Json;
          completed_at?: string | null;
          course_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          field_feedback?: string;
          field_grade?: string;
          field_likelihood?: string | null;
          field_reasons?: string | null;
          id?: string;
          invoke_target?: string;
          kind?: string;
          last_error?: string | null;
          rejected_at?: string | null;
          rejected_by?: string | null;
          rejection_reason?: string | null;
          started_at?: string | null;
          status?: string;
          target_row_id?: string;
          target_table?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_grading_queue_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_model_settings: {
        Row: {
          created_at: string;
          gemini_api_key: string | null;
          id: string;
          is_active: boolean;
          lovable_api_key: string | null;
          model: string;
          openai_api_key: string | null;
          processing_mode: string;
          provider: string;
          tenant_id: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          created_at?: string;
          gemini_api_key?: string | null;
          id?: string;
          is_active?: boolean;
          lovable_api_key?: string | null;
          model: string;
          openai_api_key?: string | null;
          processing_mode?: string;
          provider: string;
          tenant_id?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          created_at?: string;
          gemini_api_key?: string | null;
          id?: string;
          is_active?: boolean;
          lovable_api_key?: string | null;
          model?: string;
          openai_api_key?: string | null;
          processing_mode?: string;
          provider?: string;
          tenant_id?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ai_model_settings_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_override_activations: {
        Row: {
          activated_at: string;
          code_id: string;
          expires_at: string;
          id: string;
          messages_consumed: number;
          user_id: string;
        };
        Insert: {
          activated_at?: string;
          code_id: string;
          expires_at: string;
          id?: string;
          messages_consumed?: number;
          user_id: string;
        };
        Update: {
          activated_at?: string;
          code_id?: string;
          expires_at?: string;
          id?: string;
          messages_consumed?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_override_activations_code_id_fkey";
            columns: ["code_id"];
            isOneToOne: false;
            referencedRelation: "ai_override_codes";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_override_codes: {
        Row: {
          code: string;
          created_at: string;
          created_by: string | null;
          expires_at: string | null;
          id: string;
          label: string | null;
          max_messages_per_activation: number | null;
          max_uses: number;
          revoked_at: string | null;
          revoked_by: string | null;
          uses_count: number;
          window_minutes: number;
        };
        Insert: {
          code: string;
          created_at?: string;
          created_by?: string | null;
          expires_at?: string | null;
          id?: string;
          label?: string | null;
          max_messages_per_activation?: number | null;
          max_uses?: number;
          revoked_at?: string | null;
          revoked_by?: string | null;
          uses_count?: number;
          window_minutes?: number;
        };
        Update: {
          code?: string;
          created_at?: string;
          created_by?: string | null;
          expires_at?: string | null;
          id?: string;
          label?: string | null;
          max_messages_per_activation?: number | null;
          max_uses?: number;
          revoked_at?: string | null;
          revoked_by?: string | null;
          uses_count?: number;
          window_minutes?: number;
        };
        Relationships: [];
      };
      ai_prompts: {
        Row: {
          course_id: string | null;
          created_at: string;
          id: string;
          system_prompt: string;
          tenant_id: string | null;
          updated_at: string;
          updated_by: string | null;
          use_case: string;
        };
        Insert: {
          course_id?: string | null;
          created_at?: string;
          id?: string;
          system_prompt: string;
          tenant_id?: string | null;
          updated_at?: string;
          updated_by?: string | null;
          use_case: string;
        };
        Update: {
          course_id?: string | null;
          created_at?: string;
          id?: string;
          system_prompt?: string;
          tenant_id?: string | null;
          updated_at?: string;
          updated_by?: string | null;
          use_case?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_prompts_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_prompts_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      app_settings: {
        Row: {
          default_exam_max_attempts: number;
          default_exam_max_warnings: number;
          default_exam_navigation: string;
          default_grade_scale_max: number;
          default_grade_scale_min: number;
          default_passing_grade: number;
          default_project_max_attempts: number;
          default_workshop_max_attempts: number;
          email_alert_cooldown_hours: number;
          email_alert_threshold_24h: number;
          id: string;
          max_open_answer_chars: number;
          question_bank_enabled: boolean;
          require_exam_fullscreen: boolean;
          tenant_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          default_exam_max_attempts?: number;
          default_exam_max_warnings?: number;
          default_exam_navigation?: string;
          default_grade_scale_max?: number;
          default_grade_scale_min?: number;
          default_passing_grade?: number;
          default_project_max_attempts?: number;
          default_workshop_max_attempts?: number;
          email_alert_cooldown_hours?: number;
          email_alert_threshold_24h?: number;
          id?: string;
          max_open_answer_chars?: number;
          question_bank_enabled?: boolean;
          require_exam_fullscreen?: boolean;
          tenant_id: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          default_exam_max_attempts?: number;
          default_exam_max_warnings?: number;
          default_exam_navigation?: string;
          default_grade_scale_max?: number;
          default_grade_scale_min?: number;
          default_passing_grade?: number;
          default_project_max_attempts?: number;
          default_workshop_max_attempts?: number;
          email_alert_cooldown_hours?: number;
          email_alert_threshold_24h?: number;
          id?: string;
          max_open_answer_chars?: number;
          question_bank_enabled?: boolean;
          require_exam_fullscreen?: boolean;
          tenant_id?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "app_settings_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      assessment_templates: {
        Row: {
          config: Json;
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          name: string;
          target: string;
          updated_at: string;
          visibility: string;
        };
        Insert: {
          config?: Json;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          name: string;
          target: string;
          updated_at?: string;
          visibility?: string;
        };
        Update: {
          config?: Json;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          name?: string;
          target?: string;
          updated_at?: string;
          visibility?: string;
        };
        Relationships: [];
      };
      attendance_check_in_state: {
        Row: {
          closes_at: string;
          opened_at: string;
          rotation_seconds: number;
          seed: string;
          session_id: string;
        };
        Insert: {
          closes_at: string;
          opened_at?: string;
          rotation_seconds?: number;
          seed: string;
          session_id: string;
        };
        Update: {
          closes_at?: string;
          opened_at?: string;
          rotation_seconds?: number;
          seed?: string;
          session_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "attendance_check_in_state_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: true;
            referencedRelation: "attendance_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      attendance_records: {
        Row: {
          created_at: string;
          id: string;
          note: string | null;
          session_id: string;
          status: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          note?: string | null;
          session_id: string;
          status?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          note?: string | null;
          session_id?: string;
          status?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "attendance_records_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "attendance_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      attendance_sessions: {
        Row: {
          check_in_open: boolean;
          content_class_index: number | null;
          content_id: string | null;
          course_id: string;
          created_at: string;
          created_by: string;
          cut_id: string | null;
          duration_minutes: number | null;
          google_event_id: string | null;
          id: string;
          meeting_url: string | null;
          recording_url: string | null;
          recording_video_id: string | null;
          session_date: string;
          start_time: string | null;
          title: string | null;
        };
        Insert: {
          check_in_open?: boolean;
          content_class_index?: number | null;
          content_id?: string | null;
          course_id: string;
          created_at?: string;
          created_by: string;
          cut_id?: string | null;
          duration_minutes?: number | null;
          google_event_id?: string | null;
          id?: string;
          meeting_url?: string | null;
          recording_url?: string | null;
          recording_video_id?: string | null;
          session_date: string;
          start_time?: string | null;
          title?: string | null;
        };
        Update: {
          check_in_open?: boolean;
          content_class_index?: number | null;
          content_id?: string | null;
          course_id?: string;
          created_at?: string;
          created_by?: string;
          cut_id?: string | null;
          duration_minutes?: number | null;
          google_event_id?: string | null;
          id?: string;
          meeting_url?: string | null;
          recording_url?: string | null;
          recording_video_id?: string | null;
          session_date?: string;
          start_time?: string | null;
          title?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "attendance_sessions_content_id_fkey";
            columns: ["content_id"];
            isOneToOne: false;
            referencedRelation: "generated_contents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "attendance_sessions_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "attendance_sessions_cut_id_fkey";
            columns: ["cut_id"];
            isOneToOne: false;
            referencedRelation: "grade_cuts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "attendance_sessions_recording_video_id_fkey";
            columns: ["recording_video_id"];
            isOneToOne: false;
            referencedRelation: "videos";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_logs: {
        Row: {
          action: string;
          actor_email: string | null;
          actor_id: string | null;
          actor_role: string | null;
          category: string;
          course_id: string | null;
          course_name: string | null;
          created_at: string;
          entity_id: string | null;
          entity_name: string | null;
          entity_type: string | null;
          id: string;
          metadata: Json;
          severity: string;
          tenant_id: string | null;
        };
        Insert: {
          action: string;
          actor_email?: string | null;
          actor_id?: string | null;
          actor_role?: string | null;
          category: string;
          course_id?: string | null;
          course_name?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_name?: string | null;
          entity_type?: string | null;
          id?: string;
          metadata?: Json;
          severity?: string;
          tenant_id?: string | null;
        };
        Update: {
          action?: string;
          actor_email?: string | null;
          actor_id?: string | null;
          actor_role?: string | null;
          category?: string;
          course_id?: string | null;
          course_name?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_name?: string | null;
          entity_type?: string | null;
          id?: string;
          metadata?: Json;
          severity?: string;
          tenant_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "audit_logs_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "audit_logs_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_retention_settings: {
        Row: {
          error_days: number;
          id: string;
          info_days: number;
          updated_at: string;
          updated_by: string | null;
          warning_days: number;
        };
        Insert: {
          error_days?: number;
          id?: string;
          info_days?: number;
          updated_at?: string;
          updated_by?: string | null;
          warning_days?: number;
        };
        Update: {
          error_days?: number;
          id?: string;
          info_days?: number;
          updated_at?: string;
          updated_by?: string | null;
          warning_days?: number;
        };
        Relationships: [];
      };
      calendar_oauth_states: {
        Row: {
          consumed_at: string | null;
          created_at: string;
          expires_at: string;
          nonce: string;
          origin: string;
          provider: string;
          state: string;
          teacher_id: string;
        };
        Insert: {
          consumed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          nonce: string;
          origin: string;
          provider?: string;
          state: string;
          teacher_id: string;
        };
        Update: {
          consumed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          nonce?: string;
          origin?: string;
          provider?: string;
          state?: string;
          teacher_id?: string;
        };
        Relationships: [];
      };
      certificate_settings: {
        Row: {
          certificate_message: string | null;
          footer_text: string | null;
          id: string;
          institution_logo_url: string | null;
          institution_name: string | null;
          signature_image_url: string | null;
          signature_name: string | null;
          signature_title: string | null;
          tenant_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          certificate_message?: string | null;
          footer_text?: string | null;
          id?: string;
          institution_logo_url?: string | null;
          institution_name?: string | null;
          signature_image_url?: string | null;
          signature_name?: string | null;
          signature_title?: string | null;
          tenant_id: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          certificate_message?: string | null;
          footer_text?: string | null;
          id?: string;
          institution_logo_url?: string | null;
          institution_name?: string | null;
          signature_image_url?: string | null;
          signature_name?: string | null;
          signature_title?: string | null;
          tenant_id?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "certificate_settings_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      certificates: {
        Row: {
          certificate_message: string | null;
          course_id: string;
          course_name: string;
          course_period: string | null;
          final_grade: number;
          footer_text: string | null;
          grade_scale_max: number;
          id: string;
          issued_at: string;
          issued_by: string | null;
          passing_grade: number;
          payload_hash: string;
          revoke_reason: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          short_code: string;
          signature_image_url: string | null;
          signature_name: string | null;
          signature_title: string | null;
          student_full_name: string;
          student_identification: string | null;
          teacher_names: string[];
          university_logo_url: string | null;
          university_name: string | null;
          user_id: string;
        };
        Insert: {
          certificate_message?: string | null;
          course_id: string;
          course_name: string;
          course_period?: string | null;
          final_grade: number;
          footer_text?: string | null;
          grade_scale_max: number;
          id?: string;
          issued_at?: string;
          issued_by?: string | null;
          passing_grade: number;
          payload_hash: string;
          revoke_reason?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          short_code: string;
          signature_image_url?: string | null;
          signature_name?: string | null;
          signature_title?: string | null;
          student_full_name: string;
          student_identification?: string | null;
          teacher_names?: string[];
          university_logo_url?: string | null;
          university_name?: string | null;
          user_id: string;
        };
        Update: {
          certificate_message?: string | null;
          course_id?: string;
          course_name?: string;
          course_period?: string | null;
          final_grade?: number;
          footer_text?: string | null;
          grade_scale_max?: number;
          id?: string;
          issued_at?: string;
          issued_by?: string | null;
          passing_grade?: number;
          payload_hash?: string;
          revoke_reason?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          short_code?: string;
          signature_image_url?: string | null;
          signature_name?: string | null;
          signature_title?: string | null;
          student_full_name?: string;
          student_identification?: string | null;
          teacher_names?: string[];
          university_logo_url?: string | null;
          university_name?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "certificates_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
        ];
      };
      code_execution_settings: {
        Row: {
          created_at: string | null;
          id: string;
          is_active: boolean;
          java_gui_provider: string;
          python_gui_provider: string;
          provider: string;
          updated_at: string | null;
          updated_by: string | null;
        };
        Insert: {
          created_at?: string | null;
          id?: string;
          is_active?: boolean;
          java_gui_provider?: string;
          python_gui_provider?: string;
          provider: string;
          updated_at?: string | null;
          updated_by?: string | null;
        };
        Update: {
          created_at?: string | null;
          id?: string;
          is_active?: boolean;
          java_gui_provider?: string;
          python_gui_provider?: string;
          provider?: string;
          updated_at?: string | null;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      code_executions: {
        Row: {
          created_at: string;
          execution_time_ms: number | null;
          exit_code: number | null;
          id: string;
          language: string;
          question_id: string;
          source_code: string;
          status: string;
          stderr: string | null;
          stdin: string | null;
          stdout: string | null;
          submission_id: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          execution_time_ms?: number | null;
          exit_code?: number | null;
          id?: string;
          language?: string;
          question_id: string;
          source_code: string;
          status?: string;
          stderr?: string | null;
          stdin?: string | null;
          stdout?: string | null;
          submission_id?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          execution_time_ms?: number | null;
          exit_code?: number | null;
          id?: string;
          language?: string;
          question_id?: string;
          source_code?: string;
          status?: string;
          stderr?: string | null;
          stdin?: string | null;
          stdout?: string | null;
          submission_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "code_executions_question_id_fkey";
            columns: ["question_id"];
            isOneToOne: false;
            referencedRelation: "questions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "code_executions_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
        ];
      };
      content_brand_config: {
        Row: {
          author_default: string | null;
          id: string;
          logo_url: string | null;
          primary_color: string;
          secondary_color: string;
          university_name: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          author_default?: string | null;
          id?: string;
          logo_url?: string | null;
          primary_color?: string;
          secondary_color?: string;
          university_name?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          author_default?: string | null;
          id?: string;
          logo_url?: string | null;
          primary_color?: string;
          secondary_color?: string;
          university_name?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      conversations: {
        Row: {
          created_at: string;
          id: string;
          user_a: string;
          user_a_cleared_at: string | null;
          user_a_last_read_at: string | null;
          user_b: string;
          user_b_cleared_at: string | null;
          user_b_last_read_at: string | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          user_a: string;
          user_a_cleared_at?: string | null;
          user_a_last_read_at?: string | null;
          user_b: string;
          user_b_cleared_at?: string | null;
          user_b_last_read_at?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          user_a?: string;
          user_a_cleared_at?: string | null;
          user_a_last_read_at?: string | null;
          user_b?: string;
          user_b_cleared_at?: string | null;
          user_b_last_read_at?: string | null;
        };
        Relationships: [];
      };
      course_actas: {
        Row: {
          course_id: string;
          curso_nombre: string;
          docente_nombre: string;
          generated_at: string;
          generated_by: string;
          id: string;
          integrity_hash: string;
          period_id: string | null;
          periodo_codigo: string | null;
          snapshot: Json;
          total_aprobados: number;
          total_estudiantes: number;
          total_reprobados: number;
        };
        Insert: {
          course_id: string;
          curso_nombre: string;
          docente_nombre: string;
          generated_at?: string;
          generated_by: string;
          id?: string;
          integrity_hash: string;
          period_id?: string | null;
          periodo_codigo?: string | null;
          snapshot: Json;
          total_aprobados: number;
          total_estudiantes: number;
          total_reprobados: number;
        };
        Update: {
          course_id?: string;
          curso_nombre?: string;
          docente_nombre?: string;
          generated_at?: string;
          generated_by?: string;
          id?: string;
          integrity_hash?: string;
          period_id?: string | null;
          periodo_codigo?: string | null;
          snapshot?: Json;
          total_aprobados?: number;
          total_estudiantes?: number;
          total_reprobados?: number;
        };
        Relationships: [
          {
            foreignKeyName: "course_actas_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "course_actas_period_id_fkey";
            columns: ["period_id"];
            isOneToOne: false;
            referencedRelation: "academic_periods";
            referencedColumns: ["id"];
          },
        ];
      };
      course_certificate_settings: {
        Row: {
          certificate_message: string | null;
          course_id: string;
          footer_text: string | null;
          id: string;
          institution_logo_url: string | null;
          institution_name: string | null;
          signature_image_url: string | null;
          signature_name: string | null;
          signature_title: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          certificate_message?: string | null;
          course_id: string;
          footer_text?: string | null;
          id?: string;
          institution_logo_url?: string | null;
          institution_name?: string | null;
          signature_image_url?: string | null;
          signature_name?: string | null;
          signature_title?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          certificate_message?: string | null;
          course_id?: string;
          footer_text?: string | null;
          id?: string;
          institution_logo_url?: string | null;
          institution_name?: string | null;
          signature_image_url?: string | null;
          signature_name?: string | null;
          signature_title?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "course_certificate_settings_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: true;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
        ];
      };
      course_enrollments: {
        Row: {
          course_id: string;
          created_at: string;
          id: string;
          user_id: string;
        };
        Insert: {
          course_id: string;
          created_at?: string;
          id?: string;
          user_id: string;
        };
        Update: {
          course_id?: string;
          created_at?: string;
          id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "course_enrollments_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "course_enrollments_user_profile_fk";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      course_grading_config: {
        Row: {
          course_id: string;
          coursework_weight: number;
          final_project_weight: number;
          updated_at: string;
        };
        Insert: {
          course_id: string;
          coursework_weight?: number;
          final_project_weight?: number;
          updated_at?: string;
        };
        Update: {
          course_id?: string;
          coursework_weight?: number;
          final_project_weight?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "course_grading_config_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: true;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
        ];
      };
      course_schedules: {
        Row: {
          aula: string | null;
          course_id: string;
          created_at: string;
          day_of_week: number;
          end_time: string;
          id: string;
          modalidad: string;
          notes: string | null;
          start_time: string;
          updated_at: string;
        };
        Insert: {
          aula?: string | null;
          course_id: string;
          created_at?: string;
          day_of_week: number;
          end_time: string;
          id?: string;
          modalidad?: string;
          notes?: string | null;
          start_time: string;
          updated_at?: string;
        };
        Update: {
          aula?: string | null;
          course_id?: string;
          created_at?: string;
          day_of_week?: number;
          end_time?: string;
          id?: string;
          modalidad?: string;
          notes?: string | null;
          start_time?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "course_schedules_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
        ];
      };
      course_teachers: {
        Row: {
          course_id: string;
          created_at: string;
          id: string;
          user_id: string;
        };
        Insert: {
          course_id: string;
          created_at?: string;
          id?: string;
          user_id: string;
        };
        Update: {
          course_id?: string;
          created_at?: string;
          id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "course_teachers_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
        ];
      };
      courses: {
        Row: {
          attendance_weight: number;
          code: string | null;
          created_at: string;
          description: string | null;
          end_date: string | null;
          exam_weight: number;
          grade_scale_max: number;
          grade_scale_min: number;
          grupo: string | null;
          id: string;
          language: string;
          max_exam_attempts: number;
          name: string;
          passing_grade: number;
          period: string | null;
          period_id: string | null;
          program_id: string | null;
          project_weight: number;
          semestre: number | null;
          start_date: string | null;
          subject_id: string | null;
          tenant_id: string;
          updated_at: string;
          workshop_weight: number;
        };
        Insert: {
          attendance_weight?: number;
          code?: string | null;
          created_at?: string;
          description?: string | null;
          end_date?: string | null;
          exam_weight?: number;
          grade_scale_max?: number;
          grade_scale_min?: number;
          grupo?: string | null;
          id?: string;
          language?: string;
          max_exam_attempts?: number;
          name: string;
          passing_grade?: number;
          period?: string | null;
          period_id?: string | null;
          program_id?: string | null;
          project_weight?: number;
          semestre?: number | null;
          start_date?: string | null;
          subject_id?: string | null;
          tenant_id: string;
          updated_at?: string;
          workshop_weight?: number;
        };
        Update: {
          attendance_weight?: number;
          code?: string | null;
          created_at?: string;
          description?: string | null;
          end_date?: string | null;
          exam_weight?: number;
          grade_scale_max?: number;
          grade_scale_min?: number;
          grupo?: string | null;
          id?: string;
          language?: string;
          max_exam_attempts?: number;
          name?: string;
          passing_grade?: number;
          period?: string | null;
          period_id?: string | null;
          program_id?: string | null;
          project_weight?: number;
          semestre?: number | null;
          start_date?: string | null;
          subject_id?: string | null;
          tenant_id?: string;
          updated_at?: string;
          workshop_weight?: number;
        };
        Relationships: [
          {
            foreignKeyName: "courses_period_id_fkey";
            columns: ["period_id"];
            isOneToOne: false;
            referencedRelation: "academic_periods";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "courses_program_id_fkey";
            columns: ["program_id"];
            isOneToOne: false;
            referencedRelation: "academic_programs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "courses_subject_id_fkey";
            columns: ["subject_id"];
            isOneToOne: false;
            referencedRelation: "academic_subjects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "courses_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      cron_job_descriptions: {
        Row: {
          description: string;
          jobname: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          description: string;
          jobname: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          description?: string;
          jobname?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      db_backups: {
        Row: {
          completed_at: string | null;
          created_at: string;
          created_by: string | null;
          error: string | null;
          file_path: string | null;
          id: string;
          label: string | null;
          row_count: number | null;
          size_bytes: number | null;
          source: string;
          started_at: string | null;
          status: string;
          tables: string[];
        };
        Insert: {
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          error?: string | null;
          file_path?: string | null;
          id?: string;
          label?: string | null;
          row_count?: number | null;
          size_bytes?: number | null;
          source: string;
          started_at?: string | null;
          status?: string;
          tables: string[];
        };
        Update: {
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          error?: string | null;
          file_path?: string | null;
          id?: string;
          label?: string | null;
          row_count?: number | null;
          size_bytes?: number | null;
          source?: string;
          started_at?: string | null;
          status?: string;
          tables?: string[];
        };
        Relationships: [];
      };
      email_change_tokens: {
        Row: {
          applied_at: string | null;
          apply_after: string | null;
          cancel_token: string | null;
          cancelled_at: string | null;
          confirmed_at: string | null;
          created_at: string;
          expires_at: string;
          id: string;
          new_email: string;
          request_ip: string | null;
          request_ua: string | null;
          token: string;
          used_at: string | null;
          user_id: string;
        };
        Insert: {
          applied_at?: string | null;
          apply_after?: string | null;
          cancel_token?: string | null;
          cancelled_at?: string | null;
          confirmed_at?: string | null;
          created_at?: string;
          expires_at: string;
          id?: string;
          new_email: string;
          request_ip?: string | null;
          request_ua?: string | null;
          token: string;
          used_at?: string | null;
          user_id: string;
        };
        Update: {
          applied_at?: string | null;
          apply_after?: string | null;
          cancel_token?: string | null;
          cancelled_at?: string | null;
          confirmed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          id?: string;
          new_email?: string;
          request_ip?: string | null;
          request_ua?: string | null;
          token?: string;
          used_at?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      email_settings: {
        Row: {
          enabled_kinds: Json;
          globally_enabled: boolean;
          id: number;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          enabled_kinds?: Json;
          globally_enabled?: boolean;
          id?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          enabled_kinds?: Json;
          globally_enabled?: boolean;
          id?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      error_event_status: {
        Row: {
          audit_log_id: string;
          reviewed_at: string | null;
          reviewed_by: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          audit_log_id: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          audit_log_id?: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "error_event_status_audit_log_id_fkey";
            columns: ["audit_log_id"];
            isOneToOne: true;
            referencedRelation: "audit_logs";
            referencedColumns: ["id"];
          },
        ];
      };
      exam_assignments: {
        Row: {
          created_at: string;
          exam_id: string;
          id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          exam_id: string;
          id?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          exam_id?: string;
          id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "exam_assignments_exam_id_fkey";
            columns: ["exam_id"];
            isOneToOne: false;
            referencedRelation: "exams";
            referencedColumns: ["id"];
          },
        ];
      };
      exam_notes: {
        Row: {
          content: string;
          created_at: string;
          exam_id: string;
          id: string;
          rejection_reason: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          content: string;
          created_at?: string;
          exam_id: string;
          id?: string;
          rejection_reason?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          content?: string;
          created_at?: string;
          exam_id?: string;
          id?: string;
          rejection_reason?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "exam_notes_exam_id_fkey";
            columns: ["exam_id"];
            isOneToOne: false;
            referencedRelation: "exams";
            referencedColumns: ["id"];
          },
        ];
      };
      exam_timer_controls: {
        Row: {
          action: string;
          created_at: string;
          created_by: string;
          exam_id: string;
          extra_seconds: number | null;
          id: string;
          target_user_id: string | null;
        };
        Insert: {
          action: string;
          created_at?: string;
          created_by: string;
          exam_id: string;
          extra_seconds?: number | null;
          id?: string;
          target_user_id?: string | null;
        };
        Update: {
          action?: string;
          created_at?: string;
          created_by?: string;
          exam_id?: string;
          extra_seconds?: number | null;
          id?: string;
          target_user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "exam_timer_controls_exam_id_fkey";
            columns: ["exam_id"];
            isOneToOne: false;
            referencedRelation: "exams";
            referencedColumns: ["id"];
          },
        ];
      };
      exams: {
        Row: {
          allow_exam_notes: boolean;
          course_id: string;
          created_at: string;
          created_by: string;
          cut_id: string | null;
          description: string | null;
          end_time: string;
          id: string;
          is_external: boolean;
          max_attempts: number | null;
          max_warnings: number;
          navigation_type: string;
          parent_exam_id: string | null;
          retry_mode: string;
          schedule_type: string;
          shuffle_enabled: boolean;
          source_content_id: string | null;
          start_time: string;
          status: string;
          time_limit_minutes: number;
          title: string;
          updated_at: string;
          weight: number;
        };
        Insert: {
          allow_exam_notes?: boolean;
          course_id: string;
          created_at?: string;
          created_by: string;
          cut_id?: string | null;
          description?: string | null;
          end_time: string;
          id?: string;
          is_external?: boolean;
          max_attempts?: number | null;
          max_warnings?: number;
          navigation_type?: string;
          parent_exam_id?: string | null;
          retry_mode?: string;
          schedule_type?: string;
          shuffle_enabled?: boolean;
          source_content_id?: string | null;
          start_time: string;
          status?: string;
          time_limit_minutes?: number;
          title: string;
          updated_at?: string;
          weight?: number;
        };
        Update: {
          allow_exam_notes?: boolean;
          course_id?: string;
          created_at?: string;
          created_by?: string;
          cut_id?: string | null;
          description?: string | null;
          end_time?: string;
          id?: string;
          is_external?: boolean;
          max_attempts?: number | null;
          max_warnings?: number;
          navigation_type?: string;
          parent_exam_id?: string | null;
          retry_mode?: string;
          schedule_type?: string;
          shuffle_enabled?: boolean;
          source_content_id?: string | null;
          start_time?: string;
          status?: string;
          time_limit_minutes?: number;
          title?: string;
          updated_at?: string;
          weight?: number;
        };
        Relationships: [
          {
            foreignKeyName: "exams_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "exams_cut_id_fkey";
            columns: ["cut_id"];
            isOneToOne: false;
            referencedRelation: "grade_cuts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "exams_parent_exam_id_fkey";
            columns: ["parent_exam_id"];
            isOneToOne: false;
            referencedRelation: "exams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "exams_source_content_id_fkey";
            columns: ["source_content_id"];
            isOneToOne: false;
            referencedRelation: "generated_contents";
            referencedColumns: ["id"];
          },
        ];
      };
      feedback_attachments: {
        Row: {
          comment_id: string;
          created_at: string;
          id: string;
          mime_type: string | null;
          name: string;
          path: string;
          size_bytes: number | null;
          uploaded_by: string;
        };
        Insert: {
          comment_id: string;
          created_at?: string;
          id?: string;
          mime_type?: string | null;
          name: string;
          path: string;
          size_bytes?: number | null;
          uploaded_by: string;
        };
        Update: {
          comment_id?: string;
          created_at?: string;
          id?: string;
          mime_type?: string | null;
          name?: string;
          path?: string;
          size_bytes?: number | null;
          uploaded_by?: string;
        };
        Relationships: [
          {
            foreignKeyName: "feedback_attachments_comment_id_fkey";
            columns: ["comment_id"];
            isOneToOne: false;
            referencedRelation: "feedback_comments";
            referencedColumns: ["id"];
          },
        ];
      };
      feedback_comments: {
        Row: {
          author_role: string;
          body: string;
          created_at: string;
          id: string;
          thread_id: string;
          user_id: string;
        };
        Insert: {
          author_role?: string;
          body: string;
          created_at?: string;
          id?: string;
          thread_id: string;
          user_id: string;
        };
        Update: {
          author_role?: string;
          body?: string;
          created_at?: string;
          id?: string;
          thread_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "feedback_comments_thread_id_fkey";
            columns: ["thread_id"];
            isOneToOne: false;
            referencedRelation: "feedback_threads";
            referencedColumns: ["id"];
          },
        ];
      };
      feedback_threads: {
        Row: {
          closed: boolean;
          closed_at: string | null;
          closed_by: string | null;
          created_at: string;
          id: string;
          parent_kind: string;
          question_id: string;
          submission_id: string;
        };
        Insert: {
          closed?: boolean;
          closed_at?: string | null;
          closed_by?: string | null;
          created_at?: string;
          id?: string;
          parent_kind: string;
          question_id: string;
          submission_id: string;
        };
        Update: {
          closed?: boolean;
          closed_at?: string | null;
          closed_by?: string | null;
          created_at?: string;
          id?: string;
          parent_kind?: string;
          question_id?: string;
          submission_id?: string;
        };
        Relationships: [];
      };
      forum_replies: {
        Row: {
          author_id: string | null;
          body: string;
          created_at: string;
          id: string;
          is_official: boolean;
          thread_id: string;
          updated_at: string;
          upvotes: number;
        };
        Insert: {
          author_id?: string | null;
          body: string;
          created_at?: string;
          id?: string;
          is_official?: boolean;
          thread_id: string;
          updated_at?: string;
          upvotes?: number;
        };
        Update: {
          author_id?: string | null;
          body?: string;
          created_at?: string;
          id?: string;
          is_official?: boolean;
          thread_id?: string;
          updated_at?: string;
          upvotes?: number;
        };
        Relationships: [
          {
            foreignKeyName: "forum_replies_thread_id_fkey";
            columns: ["thread_id"];
            isOneToOne: false;
            referencedRelation: "forum_threads";
            referencedColumns: ["id"];
          },
        ];
      };
      forum_threads: {
        Row: {
          author_id: string | null;
          body: string;
          course_id: string;
          created_at: string;
          forum_id: string;
          id: string;
          is_locked: boolean;
          is_pinned: boolean;
          last_activity_at: string;
          official_reply_id: string | null;
          reply_count: number;
          tags: string[];
          title: string;
          updated_at: string;
          upvotes: number;
        };
        Insert: {
          author_id?: string | null;
          body: string;
          course_id: string;
          created_at?: string;
          forum_id: string;
          id?: string;
          is_locked?: boolean;
          is_pinned?: boolean;
          last_activity_at?: string;
          official_reply_id?: string | null;
          reply_count?: number;
          tags?: string[];
          title: string;
          updated_at?: string;
          upvotes?: number;
        };
        Update: {
          author_id?: string | null;
          body?: string;
          course_id?: string;
          created_at?: string;
          forum_id?: string;
          id?: string;
          is_locked?: boolean;
          is_pinned?: boolean;
          last_activity_at?: string;
          official_reply_id?: string | null;
          reply_count?: number;
          tags?: string[];
          title?: string;
          updated_at?: string;
          upvotes?: number;
        };
        Relationships: [
          {
            foreignKeyName: "forum_threads_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "forum_threads_forum_id_fkey";
            columns: ["forum_id"];
            isOneToOne: false;
            referencedRelation: "forums";
            referencedColumns: ["id"];
          },
        ];
      };
      forum_upvotes: {
        Row: {
          created_at: string;
          target_id: string;
          target_type: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          target_id: string;
          target_type: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          target_id?: string;
          target_type?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      forums: {
        Row: {
          closes_at: string | null;
          course_id: string;
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          manually_closed_at: string | null;
          opens_at: string | null;
          session_id: string | null;
          title: string;
          updated_at: string;
        };
        Insert: {
          closes_at?: string | null;
          course_id: string;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          manually_closed_at?: string | null;
          opens_at?: string | null;
          session_id?: string | null;
          title: string;
          updated_at?: string;
        };
        Update: {
          closes_at?: string | null;
          course_id?: string;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          manually_closed_at?: string | null;
          opens_at?: string | null;
          session_id?: string | null;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "forums_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "forums_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "attendance_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      generated_contents: {
        Row: {
          author: string | null;
          course_id: string | null;
          created_at: string;
          display_name: string;
          duration_minutes: number | null;
          error: string | null;
          files: Json;
          id: string;
          instructions: string | null;
          language: string;
          modality: string | null;
          mode: Database["public"]["Enums"]["content_mode"];
          n_classes: number | null;
          prompt_overrides: Json;
          raw_output: string | null;
          release_after_session_date: boolean;
          status: Database["public"]["Enums"]["content_status"];
          tags: string[] | null;
          teacher_id: string;
          topic: string;
          updated_at: string;
        };
        Insert: {
          author?: string | null;
          course_id?: string | null;
          created_at?: string;
          display_name: string;
          duration_minutes?: number | null;
          error?: string | null;
          files?: Json;
          id?: string;
          instructions?: string | null;
          language?: string;
          modality?: string | null;
          mode: Database["public"]["Enums"]["content_mode"];
          n_classes?: number | null;
          prompt_overrides?: Json;
          raw_output?: string | null;
          release_after_session_date?: boolean;
          status?: Database["public"]["Enums"]["content_status"];
          tags?: string[] | null;
          teacher_id: string;
          topic: string;
          updated_at?: string;
        };
        Update: {
          author?: string | null;
          course_id?: string | null;
          created_at?: string;
          display_name?: string;
          duration_minutes?: number | null;
          error?: string | null;
          files?: Json;
          id?: string;
          instructions?: string | null;
          language?: string;
          modality?: string | null;
          mode?: Database["public"]["Enums"]["content_mode"];
          n_classes?: number | null;
          prompt_overrides?: Json;
          raw_output?: string | null;
          release_after_session_date?: boolean;
          status?: Database["public"]["Enums"]["content_status"];
          tags?: string[] | null;
          teacher_id?: string;
          topic?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "generated_contents_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
        ];
      };
      grade_cut_items: {
        Row: {
          created_at: string;
          cut_id: string;
          exam_id: string | null;
          id: string;
          item_type: string;
          project_id: string | null;
          project_title: string | null;
          weight: number;
          workshop_id: string | null;
        };
        Insert: {
          created_at?: string;
          cut_id: string;
          exam_id?: string | null;
          id?: string;
          item_type: string;
          project_id?: string | null;
          project_title?: string | null;
          weight?: number;
          workshop_id?: string | null;
        };
        Update: {
          created_at?: string;
          cut_id?: string;
          exam_id?: string | null;
          id?: string;
          item_type?: string;
          project_id?: string | null;
          project_title?: string | null;
          weight?: number;
          workshop_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "grade_cut_items_cut_id_fkey";
            columns: ["cut_id"];
            isOneToOne: false;
            referencedRelation: "grade_cuts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grade_cut_items_exam_id_fkey";
            columns: ["exam_id"];
            isOneToOne: false;
            referencedRelation: "exams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grade_cut_items_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grade_cut_items_workshop_id_fkey";
            columns: ["workshop_id"];
            isOneToOne: false;
            referencedRelation: "workshops";
            referencedColumns: ["id"];
          },
        ];
      };
      grade_cuts: {
        Row: {
          attendance_weight: number;
          course_id: string;
          created_at: string;
          end_date: string | null;
          exam_weight: number;
          id: string;
          name: string;
          position: number;
          project_weight: number;
          start_date: string | null;
          updated_at: string;
          weight: number;
          workshop_weight: number;
        };
        Insert: {
          attendance_weight?: number;
          course_id: string;
          created_at?: string;
          end_date?: string | null;
          exam_weight?: number;
          id?: string;
          name: string;
          position?: number;
          project_weight?: number;
          start_date?: string | null;
          updated_at?: string;
          weight?: number;
          workshop_weight?: number;
        };
        Update: {
          attendance_weight?: number;
          course_id?: string;
          created_at?: string;
          end_date?: string | null;
          exam_weight?: number;
          id?: string;
          name?: string;
          position?: number;
          project_weight?: number;
          start_date?: string | null;
          updated_at?: string;
          weight?: number;
          workshop_weight?: number;
        };
        Relationships: [
          {
            foreignKeyName: "grade_cuts_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
        ];
      };
      message_attachments: {
        Row: {
          created_at: string;
          id: string;
          message_id: string;
          mime_type: string | null;
          name: string;
          path: string;
          size_bytes: number | null;
          uploaded_by: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          message_id: string;
          mime_type?: string | null;
          name: string;
          path: string;
          size_bytes?: number | null;
          uploaded_by: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          message_id?: string;
          mime_type?: string | null;
          name?: string;
          path?: string;
          size_bytes?: number | null;
          uploaded_by?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_attachments_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          body: string;
          conversation_id: string;
          created_at: string;
          edited_at: string | null;
          id: string;
          sender_id: string;
        };
        Insert: {
          body: string;
          conversation_id: string;
          created_at?: string;
          edited_at?: string | null;
          id?: string;
          sender_id: string;
        };
        Update: {
          body?: string;
          conversation_id?: string;
          created_at?: string;
          edited_at?: string | null;
          id?: string;
          sender_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
        ];
      };
      module_visibility: {
        Row: {
          display_order: number;
          enabled: boolean;
          id: string;
          module_key: string;
          role: string;
          tenant_id: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          display_order?: number;
          enabled?: boolean;
          id?: string;
          module_key: string;
          role: string;
          tenant_id?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          display_order?: number;
          enabled?: boolean;
          id?: string;
          module_key?: string;
          role?: string;
          tenant_id?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "module_visibility_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      notifications: {
        Row: {
          body: string;
          created_at: string;
          email_delivered_at: string | null;
          email_skipped_reason: string | null;
          exam_id: string | null;
          id: string;
          kind: string;
          link: string | null;
          read: boolean;
          related_user_id: string | null;
          source_role: string | null;
          tenant_id: string | null;
          title: string;
          user_id: string;
        };
        Insert: {
          body: string;
          created_at?: string;
          email_delivered_at?: string | null;
          email_skipped_reason?: string | null;
          exam_id?: string | null;
          id?: string;
          kind?: string;
          link?: string | null;
          read?: boolean;
          related_user_id?: string | null;
          source_role?: string | null;
          tenant_id?: string | null;
          title: string;
          user_id: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          email_delivered_at?: string | null;
          email_skipped_reason?: string | null;
          exam_id?: string | null;
          id?: string;
          kind?: string;
          link?: string | null;
          read?: boolean;
          related_user_id?: string | null;
          source_role?: string | null;
          tenant_id?: string | null;
          title?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_exam_id_fkey";
            columns: ["exam_id"];
            isOneToOne: false;
            referencedRelation: "exams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notifications_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      password_reset_tokens: {
        Row: {
          created_at: string;
          expires_at: string;
          id: string;
          request_ip: string | null;
          request_ua: string | null;
          token: string;
          used_at: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          expires_at: string;
          id?: string;
          request_ip?: string | null;
          request_ua?: string | null;
          token: string;
          used_at?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          expires_at?: string;
          id?: string;
          request_ip?: string | null;
          request_ua?: string | null;
          token?: string;
          used_at?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      poll_options: {
        Row: {
          created_at: string;
          id: string;
          label: string;
          max_responses: number | null;
          poll_id: string;
          position: number;
          responses_count: number;
        };
        Insert: {
          created_at?: string;
          id?: string;
          label: string;
          max_responses?: number | null;
          poll_id: string;
          position?: number;
          responses_count?: number;
        };
        Update: {
          created_at?: string;
          id?: string;
          label?: string;
          max_responses?: number | null;
          poll_id?: string;
          position?: number;
          responses_count?: number;
        };
        Relationships: [
          {
            foreignKeyName: "poll_options_poll_id_fkey";
            columns: ["poll_id"];
            isOneToOne: false;
            referencedRelation: "polls";
            referencedColumns: ["id"];
          },
        ];
      };
      poll_responses: {
        Row: {
          created_at: string;
          id: string;
          option_id: string;
          poll_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          option_id: string;
          poll_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          option_id?: string;
          poll_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "poll_responses_option_id_fkey";
            columns: ["option_id"];
            isOneToOne: false;
            referencedRelation: "poll_options";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "poll_responses_poll_id_fkey";
            columns: ["poll_id"];
            isOneToOne: false;
            referencedRelation: "polls";
            referencedColumns: ["id"];
          },
        ];
      };
      polls: {
        Row: {
          attendance_session_id: string | null;
          closed_manually: boolean;
          closes_at: string | null;
          course_id: string;
          created_at: string;
          created_by: string;
          description: string | null;
          id: string;
          opens_at: string;
          poll_type: Database["public"]["Enums"]["poll_type"];
          results_visible_to_students: Database["public"]["Enums"]["poll_results_visibility"];
          title: string;
          updated_at: string;
        };
        Insert: {
          attendance_session_id?: string | null;
          closed_manually?: boolean;
          closes_at?: string | null;
          course_id: string;
          created_at?: string;
          created_by: string;
          description?: string | null;
          id?: string;
          opens_at?: string;
          poll_type?: Database["public"]["Enums"]["poll_type"];
          results_visible_to_students?: Database["public"]["Enums"]["poll_results_visibility"];
          title: string;
          updated_at?: string;
        };
        Update: {
          attendance_session_id?: string | null;
          closed_manually?: boolean;
          closes_at?: string | null;
          course_id?: string;
          created_at?: string;
          created_by?: string;
          description?: string | null;
          id?: string;
          opens_at?: string;
          poll_type?: Database["public"]["Enums"]["poll_type"];
          results_visible_to_students?: Database["public"]["Enums"]["poll_results_visibility"];
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "polls_attendance_session_id_fkey";
            columns: ["attendance_session_id"];
            isOneToOne: false;
            referencedRelation: "attendance_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "polls_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          codigo: string | null;
          cohorte: string | null;
          created_at: string;
          documento: string | null;
          estado: string | null;
          full_name: string;
          id: string;
          institutional_email: string;
          last_sign_in_at: string | null;
          must_change_password: boolean;
          notification_preferences: Json;
          personal_email: string | null;
          programa_id: string | null;
          tenant_id: string | null;
          updated_at: string;
        };
        Insert: {
          codigo?: string | null;
          cohorte?: string | null;
          created_at?: string;
          documento?: string | null;
          estado?: string | null;
          full_name: string;
          id: string;
          institutional_email: string;
          last_sign_in_at?: string | null;
          must_change_password?: boolean;
          notification_preferences?: Json;
          personal_email?: string | null;
          programa_id?: string | null;
          tenant_id?: string | null;
          updated_at?: string;
        };
        Update: {
          codigo?: string | null;
          cohorte?: string | null;
          created_at?: string;
          documento?: string | null;
          estado?: string | null;
          full_name?: string;
          id?: string;
          institutional_email?: string;
          last_sign_in_at?: string | null;
          must_change_password?: boolean;
          notification_preferences?: Json;
          personal_email?: string | null;
          programa_id?: string | null;
          tenant_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_programa_id_fkey";
            columns: ["programa_id"];
            isOneToOne: false;
            referencedRelation: "academic_programs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "profiles_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      project_assignments: {
        Row: {
          created_at: string;
          id: string;
          project_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          project_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          project_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_assignments_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      project_courses: {
        Row: {
          course_id: string;
          created_at: string;
          cut_id: string | null;
          id: string;
          project_id: string;
          weight: number;
        };
        Insert: {
          course_id: string;
          created_at?: string;
          cut_id?: string | null;
          id?: string;
          project_id: string;
          weight?: number;
        };
        Update: {
          course_id?: string;
          created_at?: string;
          cut_id?: string | null;
          id?: string;
          project_id?: string;
          weight?: number;
        };
        Relationships: [
          {
            foreignKeyName: "project_courses_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_courses_cut_id_fkey";
            columns: ["cut_id"];
            isOneToOne: false;
            referencedRelation: "grade_cuts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_courses_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      project_files: {
        Row: {
          content: string | null;
          created_at: string;
          description: string | null;
          expected_rubric: string | null;
          id: string;
          language: string | null;
          options: Json | null;
          points: number;
          position: number;
          project_id: string;
          starter_code: string | null;
          title: string;
          type: string;
          zip_single: boolean;
        };
        Insert: {
          content?: string | null;
          created_at?: string;
          description?: string | null;
          expected_rubric?: string | null;
          id?: string;
          language?: string | null;
          options?: Json | null;
          points?: number;
          position?: number;
          project_id: string;
          starter_code?: string | null;
          title: string;
          type?: string;
          zip_single?: boolean;
        };
        Update: {
          content?: string | null;
          created_at?: string;
          description?: string | null;
          expected_rubric?: string | null;
          id?: string;
          language?: string | null;
          options?: Json | null;
          points?: number;
          position?: number;
          project_id?: string;
          starter_code?: string | null;
          title?: string;
          type?: string;
          zip_single?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "project_files_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      project_group_members: {
        Row: {
          group_id: string;
          joined_at: string;
          user_id: string;
        };
        Insert: {
          group_id: string;
          joined_at?: string;
          user_id: string;
        };
        Update: {
          group_id?: string;
          joined_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_group_members_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "project_groups";
            referencedColumns: ["id"];
          },
        ];
      };
      project_groups: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          project_id: string;
          signup_code: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name: string;
          project_id: string;
          signup_code?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          project_id?: string;
          signup_code?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_groups_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      project_intro_videos: {
        Row: {
          created_at: string;
          id: string;
          position: number;
          project_id: string;
          title: string | null;
          url: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          position?: number;
          project_id: string;
          title?: string | null;
          url: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          position?: number;
          project_id?: string;
          title?: string | null;
          url?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_intro_videos_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      project_submission_attachments: {
        Row: {
          created_at: string;
          file_name: string;
          id: string;
          mime_type: string | null;
          position: number;
          project_submission_file_id: string;
          size_bytes: number | null;
          storage_path: string;
        };
        Insert: {
          created_at?: string;
          file_name: string;
          id?: string;
          mime_type?: string | null;
          position?: number;
          project_submission_file_id: string;
          size_bytes?: number | null;
          storage_path: string;
        };
        Update: {
          created_at?: string;
          file_name?: string;
          id?: string;
          mime_type?: string | null;
          position?: number;
          project_submission_file_id?: string;
          size_bytes?: number | null;
          storage_path?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_submission_attachments_project_submission_file_id_fkey";
            columns: ["project_submission_file_id"];
            isOneToOne: false;
            referencedRelation: "project_submission_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_submission_attachments_psf_fk";
            columns: ["project_submission_file_id"];
            isOneToOne: false;
            referencedRelation: "project_submission_files";
            referencedColumns: ["id"];
          },
        ];
      };
      project_submission_files: {
        Row: {
          ai_feedback: string | null;
          ai_grade: number | null;
          ai_likelihood: number | null;
          ai_reasons: string | null;
          code_paths: string[] | null;
          content: string | null;
          created_at: string;
          file_id: string;
          id: string;
          selected_option: string | null;
          submission_id: string;
          updated_at: string;
          zip_path: string | null;
        };
        Insert: {
          ai_feedback?: string | null;
          ai_grade?: number | null;
          ai_likelihood?: number | null;
          ai_reasons?: string | null;
          code_paths?: string[] | null;
          content?: string | null;
          created_at?: string;
          file_id: string;
          id?: string;
          selected_option?: string | null;
          submission_id: string;
          updated_at?: string;
          zip_path?: string | null;
        };
        Update: {
          ai_feedback?: string | null;
          ai_grade?: number | null;
          ai_likelihood?: number | null;
          ai_reasons?: string | null;
          code_paths?: string[] | null;
          content?: string | null;
          created_at?: string;
          file_id?: string;
          id?: string;
          selected_option?: string | null;
          submission_id?: string;
          updated_at?: string;
          zip_path?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "project_submission_files_file_fk";
            columns: ["file_id"];
            isOneToOne: false;
            referencedRelation: "project_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_submission_files_file_id_fkey";
            columns: ["file_id"];
            isOneToOne: false;
            referencedRelation: "project_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_submission_files_submission_fk";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "project_submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_submission_files_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "project_submissions";
            referencedColumns: ["id"];
          },
        ];
      };
      project_submission_video_views: {
        Row: {
          submission_id: string;
          video_id: string;
          watched_at: string;
        };
        Insert: {
          submission_id: string;
          video_id: string;
          watched_at?: string;
        };
        Update: {
          submission_id?: string;
          video_id?: string;
          watched_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_submission_video_views_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "project_submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_submission_video_views_video_id_fkey";
            columns: ["video_id"];
            isOneToOne: false;
            referencedRelation: "project_intro_videos";
            referencedColumns: ["id"];
          },
        ];
      };
      project_submissions: {
        Row: {
          ai_detected: boolean;
          ai_detected_reasons: string | null;
          ai_detected_score: number | null;
          ai_feedback: string | null;
          ai_grade: number | null;
          ai_review_at: string | null;
          ai_review_by: string | null;
          attempt_count: number;
          created_at: string;
          defense_at: string | null;
          defense_factor: number | null;
          defense_notes: string | null;
          final_grade: number | null;
          group_id: string | null;
          id: string;
          project_id: string;
          repository_url: string | null;
          status: string;
          submission_grade: number | null;
          submitted_at: string | null;
          teacher_feedback: string | null;
          updated_at: string;
          user_id: string;
          video_watched_at: string | null;
          zip_url: string | null;
        };
        Insert: {
          ai_detected?: boolean;
          ai_detected_reasons?: string | null;
          ai_detected_score?: number | null;
          ai_feedback?: string | null;
          ai_grade?: number | null;
          ai_review_at?: string | null;
          ai_review_by?: string | null;
          attempt_count?: number;
          created_at?: string;
          defense_at?: string | null;
          defense_factor?: number | null;
          defense_notes?: string | null;
          final_grade?: number | null;
          group_id?: string | null;
          id?: string;
          project_id: string;
          repository_url?: string | null;
          status?: string;
          submission_grade?: number | null;
          submitted_at?: string | null;
          teacher_feedback?: string | null;
          updated_at?: string;
          user_id: string;
          video_watched_at?: string | null;
          zip_url?: string | null;
        };
        Update: {
          ai_detected?: boolean;
          ai_detected_reasons?: string | null;
          ai_detected_score?: number | null;
          ai_feedback?: string | null;
          ai_grade?: number | null;
          ai_review_at?: string | null;
          ai_review_by?: string | null;
          attempt_count?: number;
          created_at?: string;
          defense_at?: string | null;
          defense_factor?: number | null;
          defense_notes?: string | null;
          final_grade?: number | null;
          group_id?: string | null;
          id?: string;
          project_id?: string;
          repository_url?: string | null;
          status?: string;
          submission_grade?: number | null;
          submitted_at?: string | null;
          teacher_feedback?: string | null;
          updated_at?: string;
          user_id?: string;
          video_watched_at?: string | null;
          zip_url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "project_submissions_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "project_groups";
            referencedColumns: ["id"];
          },
        ];
      };
      projects: {
        Row: {
          ai_generated: boolean;
          code_intro_video_id: string | null;
          code_intro_video_url: string | null;
          course_id: string;
          created_at: string;
          created_by: string;
          cut_id: string | null;
          description: string | null;
          due_date: string | null;
          external_link: string | null;
          group_mode: string;
          group_size_max: number;
          group_size_min: number;
          id: string;
          instructions: string | null;
          is_external: boolean;
          max_attempts: number | null;
          max_files: number;
          max_score: number;
          project_type: string;
          source_content_id: string | null;
          start_date: string | null;
          status: string;
          title: string;
          updated_at: string;
          weight: number;
        };
        Insert: {
          ai_generated?: boolean;
          code_intro_video_id?: string | null;
          code_intro_video_url?: string | null;
          course_id: string;
          created_at?: string;
          created_by: string;
          cut_id?: string | null;
          description?: string | null;
          due_date?: string | null;
          external_link?: string | null;
          group_mode?: string;
          group_size_max?: number;
          group_size_min?: number;
          id?: string;
          instructions?: string | null;
          is_external?: boolean;
          max_attempts?: number | null;
          max_files?: number;
          max_score?: number;
          project_type?: string;
          source_content_id?: string | null;
          start_date?: string | null;
          status?: string;
          title: string;
          updated_at?: string;
          weight?: number;
        };
        Update: {
          ai_generated?: boolean;
          code_intro_video_id?: string | null;
          code_intro_video_url?: string | null;
          course_id?: string;
          created_at?: string;
          created_by?: string;
          cut_id?: string | null;
          description?: string | null;
          due_date?: string | null;
          external_link?: string | null;
          group_mode?: string;
          group_size_max?: number;
          group_size_min?: number;
          id?: string;
          instructions?: string | null;
          is_external?: boolean;
          max_attempts?: number | null;
          max_files?: number;
          max_score?: number;
          project_type?: string;
          source_content_id?: string | null;
          start_date?: string | null;
          status?: string;
          title?: string;
          updated_at?: string;
          weight?: number;
        };
        Relationships: [
          {
            foreignKeyName: "projects_code_intro_video_id_fkey";
            columns: ["code_intro_video_id"];
            isOneToOne: false;
            referencedRelation: "videos";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_source_content_id_fkey";
            columns: ["source_content_id"];
            isOneToOne: false;
            referencedRelation: "generated_contents";
            referencedColumns: ["id"];
          },
        ];
      };
      push_config: {
        Row: {
          id: number;
          send_push_url: string;
          trigger_secret: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          send_push_url: string;
          trigger_secret: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          send_push_url?: string;
          trigger_secret?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      push_subscriptions: {
        Row: {
          auth: string;
          created_at: string;
          endpoint: string;
          id: string;
          p256dh: string;
          updated_at: string;
          user_agent: string | null;
          user_id: string;
        };
        Insert: {
          auth: string;
          created_at?: string;
          endpoint: string;
          id?: string;
          p256dh: string;
          updated_at?: string;
          user_agent?: string | null;
          user_id: string;
        };
        Update: {
          auth?: string;
          created_at?: string;
          endpoint?: string;
          id?: string;
          p256dh?: string;
          updated_at?: string;
          user_agent?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      questions: {
        Row: {
          content: string;
          created_at: string;
          exam_id: string;
          expected_rubric: string | null;
          id: string;
          language: string | null;
          options: Json | null;
          points: number;
          position: number;
          starter_code: string | null;
          test_cases: Json | null;
          type: string;
        };
        Insert: {
          content: string;
          created_at?: string;
          exam_id: string;
          expected_rubric?: string | null;
          id?: string;
          language?: string | null;
          options?: Json | null;
          points?: number;
          position?: number;
          starter_code?: string | null;
          test_cases?: Json | null;
          type: string;
        };
        Update: {
          content?: string;
          created_at?: string;
          exam_id?: string;
          expected_rubric?: string | null;
          id?: string;
          language?: string | null;
          options?: Json | null;
          points?: number;
          position?: number;
          starter_code?: string | null;
          test_cases?: Json | null;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "questions_exam_id_fkey";
            columns: ["exam_id"];
            isOneToOne: false;
            referencedRelation: "exams";
            referencedColumns: ["id"];
          },
        ];
      };
      rate_limit_events: {
        Row: {
          action: string;
          actor_id: string;
          created_at: string;
          id: number;
        };
        Insert: {
          action: string;
          actor_id: string;
          created_at?: string;
          id?: number;
        };
        Update: {
          action?: string;
          actor_id?: string;
          created_at?: string;
          id?: number;
        };
        Relationships: [];
      };
      report_templates: {
        Row: {
          body_html: string;
          course_id: string | null;
          created_at: string;
          created_by: string | null;
          css: string | null;
          description: string | null;
          footer_html: string | null;
          header_html: string | null;
          id: string;
          name: string;
          owner_id: string | null;
          page_orientation: string;
          page_size: string;
          parent_id: string | null;
          scope: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          body_html?: string;
          course_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          css?: string | null;
          description?: string | null;
          footer_html?: string | null;
          header_html?: string | null;
          id?: string;
          name: string;
          owner_id?: string | null;
          page_orientation?: string;
          page_size?: string;
          parent_id?: string | null;
          scope?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          body_html?: string;
          course_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          css?: string | null;
          description?: string | null;
          footer_html?: string | null;
          header_html?: string | null;
          id?: string;
          name?: string;
          owner_id?: string | null;
          page_orientation?: string;
          page_size?: string;
          parent_id?: string | null;
          scope?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "report_templates_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "report_templates_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "report_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      scheduled_messages: {
        Row: {
          body: string;
          course_ids: string[] | null;
          created_at: string;
          creator_id: string;
          error: string | null;
          id: string;
          kind: string;
          recipient_id: string | null;
          send_at: string;
          sent_at: string | null;
          status: string;
          subject: string | null;
        };
        Insert: {
          body: string;
          course_ids?: string[] | null;
          created_at?: string;
          creator_id: string;
          error?: string | null;
          id?: string;
          kind: string;
          recipient_id?: string | null;
          send_at: string;
          sent_at?: string | null;
          status?: string;
          subject?: string | null;
        };
        Update: {
          body?: string;
          course_ids?: string[] | null;
          created_at?: string;
          creator_id?: string;
          error?: string | null;
          id?: string;
          kind?: string;
          recipient_id?: string | null;
          send_at?: string;
          sent_at?: string | null;
          status?: string;
          subject?: string | null;
        };
        Relationships: [];
      };
      similarity_pairs: {
        Row: {
          created_at: string;
          id: string;
          kind: string;
          method: string;
          question_id: string | null;
          reasons: string | null;
          ref_id: string;
          review_notes: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          score: number;
          submission_a: string;
          submission_b: string;
          user_a: string;
          user_b: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          kind: string;
          method?: string;
          question_id?: string | null;
          reasons?: string | null;
          ref_id: string;
          review_notes?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          score: number;
          submission_a: string;
          submission_b: string;
          user_a: string;
          user_b: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          kind?: string;
          method?: string;
          question_id?: string | null;
          reasons?: string | null;
          ref_id?: string;
          review_notes?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          score?: number;
          submission_a?: string;
          submission_b?: string;
          user_a?: string;
          user_b?: string;
        };
        Relationships: [];
      };
      student_calendar_tokens: {
        Row: {
          created_at: string;
          id: string;
          last_accessed_at: string | null;
          revoked_at: string | null;
          token: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          last_accessed_at?: string | null;
          revoked_at?: string | null;
          token: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          last_accessed_at?: string | null;
          revoked_at?: string | null;
          token?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      submissions: {
        Row: {
          ai_detected: boolean;
          ai_detected_reasons: string | null;
          ai_detected_score: number | null;
          ai_grade: number | null;
          ai_review_at: string | null;
          ai_review_by: string | null;
          answers: Json;
          created_at: string;
          exam_id: string;
          extra_seconds: number;
          final_override_grade: number | null;
          focus_warnings: number;
          id: string;
          started_at: string;
          status: string;
          submitted_at: string | null;
          teacher_feedback: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          ai_detected?: boolean;
          ai_detected_reasons?: string | null;
          ai_detected_score?: number | null;
          ai_grade?: number | null;
          ai_review_at?: string | null;
          ai_review_by?: string | null;
          answers?: Json;
          created_at?: string;
          exam_id: string;
          extra_seconds?: number;
          final_override_grade?: number | null;
          focus_warnings?: number;
          id?: string;
          started_at?: string;
          status?: string;
          submitted_at?: string | null;
          teacher_feedback?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          ai_detected?: boolean;
          ai_detected_reasons?: string | null;
          ai_detected_score?: number | null;
          ai_grade?: number | null;
          ai_review_at?: string | null;
          ai_review_by?: string | null;
          answers?: Json;
          created_at?: string;
          exam_id?: string;
          extra_seconds?: number;
          final_override_grade?: number | null;
          focus_warnings?: number;
          id?: string;
          started_at?: string;
          status?: string;
          submitted_at?: string | null;
          teacher_feedback?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "submissions_exam_id_fkey";
            columns: ["exam_id"];
            isOneToOne: false;
            referencedRelation: "exams";
            referencedColumns: ["id"];
          },
        ];
      };
      system_settings: {
        Row: {
          alert_threshold_pct: number;
          db_quota_mb: number;
          id: number;
          storage_quota_mb: number;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          alert_threshold_pct?: number;
          db_quota_mb?: number;
          id?: number;
          storage_quota_mb?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          alert_threshold_pct?: number;
          db_quota_mb?: number;
          id?: number;
          storage_quota_mb?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      teacher_google_tokens: {
        Row: {
          access_token: string | null;
          calendar_id: string | null;
          calendar_name: string | null;
          created_at: string;
          expires_at: string | null;
          google_email: string | null;
          provider: string;
          provider_email: string | null;
          refresh_token: string;
          teacher_id: string;
          updated_at: string;
        };
        Insert: {
          access_token?: string | null;
          calendar_id?: string | null;
          calendar_name?: string | null;
          created_at?: string;
          expires_at?: string | null;
          google_email?: string | null;
          provider?: string;
          provider_email?: string | null;
          refresh_token: string;
          teacher_id: string;
          updated_at?: string;
        };
        Update: {
          access_token?: string | null;
          calendar_id?: string | null;
          calendar_name?: string | null;
          created_at?: string;
          expires_at?: string | null;
          google_email?: string | null;
          provider?: string;
          provider_email?: string | null;
          refresh_token?: string;
          teacher_id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      tenants: {
        Row: {
          created_at: string;
          created_by: string | null;
          email_domain: string | null;
          icon_color: string | null;
          id: string;
          is_active: boolean;
          logo_path: string | null;
          logo_url: string | null;
          max_admins: number | null;
          max_students: number | null;
          max_teachers: number | null;
          name: string;
          primary_color: string | null;
          secondary_color: string | null;
          slug: string;
          text_color: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          email_domain?: string | null;
          icon_color?: string | null;
          id?: string;
          is_active?: boolean;
          logo_path?: string | null;
          logo_url?: string | null;
          max_admins?: number | null;
          max_students?: number | null;
          max_teachers?: number | null;
          name: string;
          primary_color?: string | null;
          secondary_color?: string | null;
          slug: string;
          text_color?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          email_domain?: string | null;
          icon_color?: string | null;
          id?: string;
          is_active?: boolean;
          logo_path?: string | null;
          logo_url?: string | null;
          max_admins?: number | null;
          max_students?: number | null;
          max_teachers?: number | null;
          name?: string;
          primary_color?: string | null;
          secondary_color?: string | null;
          slug?: string;
          text_color?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      tutor_chat_messages: {
        Row: {
          completion_tokens: number | null;
          content: string;
          created_at: string;
          id: string;
          prompt_tokens: number | null;
          role: string;
          session_id: string;
        };
        Insert: {
          completion_tokens?: number | null;
          content: string;
          created_at?: string;
          id?: string;
          prompt_tokens?: number | null;
          role: string;
          session_id: string;
        };
        Update: {
          completion_tokens?: number | null;
          content?: string;
          created_at?: string;
          id?: string;
          prompt_tokens?: number | null;
          role?: string;
          session_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tutor_chat_messages_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "tutor_chat_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      tutor_chat_sessions: {
        Row: {
          archived: boolean;
          course_id: string;
          created_at: string;
          id: string;
          title: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          archived?: boolean;
          course_id: string;
          created_at?: string;
          id?: string;
          title?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          archived?: boolean;
          course_id?: string;
          created_at?: string;
          id?: string;
          title?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tutor_chat_sessions_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
        ];
      };
      user_roles: {
        Row: {
          created_at: string;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
      video_views: {
        Row: {
          user_id: string;
          video_id: string;
          watched_at: string;
        };
        Insert: {
          user_id: string;
          video_id: string;
          watched_at?: string;
        };
        Update: {
          user_id?: string;
          video_id?: string;
          watched_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "video_views_video_id_fkey";
            columns: ["video_id"];
            isOneToOne: false;
            referencedRelation: "videos";
            referencedColumns: ["id"];
          },
        ];
      };
      videos: {
        Row: {
          course_id: string | null;
          created_at: string;
          description: string | null;
          duration_sec: number | null;
          id: string;
          is_archived: boolean;
          provider: string;
          storage_path: string | null;
          tenant_id: string | null;
          title: string;
          updated_at: string;
          uploaded_by: string | null;
          url: string;
        };
        Insert: {
          course_id?: string | null;
          created_at?: string;
          description?: string | null;
          duration_sec?: number | null;
          id?: string;
          is_archived?: boolean;
          provider: string;
          storage_path?: string | null;
          tenant_id?: string | null;
          title: string;
          updated_at?: string;
          uploaded_by?: string | null;
          url: string;
        };
        Update: {
          course_id?: string | null;
          created_at?: string;
          description?: string | null;
          duration_sec?: number | null;
          id?: string;
          is_archived?: boolean;
          provider?: string;
          storage_path?: string | null;
          tenant_id?: string | null;
          title?: string;
          updated_at?: string;
          uploaded_by?: string | null;
          url?: string;
        };
        Relationships: [
          {
            foreignKeyName: "videos_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "videos_tenant_id_fkey";
            columns: ["tenant_id"];
            isOneToOne: false;
            referencedRelation: "tenants";
            referencedColumns: ["id"];
          },
        ];
      };
      workshop_assignments: {
        Row: {
          created_at: string;
          id: string;
          user_id: string;
          workshop_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          user_id: string;
          workshop_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          user_id?: string;
          workshop_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workshop_assignments_workshop_id_fkey";
            columns: ["workshop_id"];
            isOneToOne: false;
            referencedRelation: "workshops";
            referencedColumns: ["id"];
          },
        ];
      };
      workshop_courses: {
        Row: {
          course_id: string;
          created_at: string;
          cut_id: string | null;
          id: string;
          weight: number | null;
          workshop_id: string;
        };
        Insert: {
          course_id: string;
          created_at?: string;
          cut_id?: string | null;
          id?: string;
          weight?: number | null;
          workshop_id: string;
        };
        Update: {
          course_id?: string;
          created_at?: string;
          cut_id?: string | null;
          id?: string;
          weight?: number | null;
          workshop_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workshop_courses_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workshop_courses_cut_id_fkey";
            columns: ["cut_id"];
            isOneToOne: false;
            referencedRelation: "grade_cuts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workshop_courses_workshop_id_fkey";
            columns: ["workshop_id"];
            isOneToOne: false;
            referencedRelation: "workshops";
            referencedColumns: ["id"];
          },
        ];
      };
      workshop_group_members: {
        Row: {
          group_id: string;
          joined_at: string;
          user_id: string;
        };
        Insert: {
          group_id: string;
          joined_at?: string;
          user_id: string;
        };
        Update: {
          group_id?: string;
          joined_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workshop_group_members_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "workshop_groups";
            referencedColumns: ["id"];
          },
        ];
      };
      workshop_groups: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          signup_code: string;
          workshop_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name: string;
          signup_code?: string;
          workshop_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          signup_code?: string;
          workshop_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workshop_groups_workshop_id_fkey";
            columns: ["workshop_id"];
            isOneToOne: false;
            referencedRelation: "workshops";
            referencedColumns: ["id"];
          },
        ];
      };
      workshop_intro_videos: {
        Row: {
          created_at: string;
          id: string;
          position: number;
          title: string | null;
          url: string;
          workshop_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          position?: number;
          title?: string | null;
          url: string;
          workshop_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          position?: number;
          title?: string | null;
          url?: string;
          workshop_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workshop_intro_videos_workshop_id_fkey";
            columns: ["workshop_id"];
            isOneToOne: false;
            referencedRelation: "workshops";
            referencedColumns: ["id"];
          },
        ];
      };
      workshop_questions: {
        Row: {
          content: string;
          created_at: string;
          expected_rubric: string | null;
          id: string;
          language: string | null;
          options: Json | null;
          points: number;
          position: number;
          starter_code: string | null;
          test_cases: Json | null;
          type: string;
          workshop_id: string;
          zip_single: boolean;
        };
        Insert: {
          content: string;
          created_at?: string;
          expected_rubric?: string | null;
          id?: string;
          language?: string | null;
          options?: Json | null;
          points?: number;
          position?: number;
          starter_code?: string | null;
          test_cases?: Json | null;
          type: string;
          workshop_id: string;
          zip_single?: boolean;
        };
        Update: {
          content?: string;
          created_at?: string;
          expected_rubric?: string | null;
          id?: string;
          language?: string | null;
          options?: Json | null;
          points?: number;
          position?: number;
          starter_code?: string | null;
          test_cases?: Json | null;
          type?: string;
          workshop_id?: string;
          zip_single?: boolean;
        };
        Relationships: [];
      };
      workshop_submission_answers: {
        Row: {
          ai_detected: boolean;
          ai_detected_reasons: string | null;
          ai_detected_score: number | null;
          ai_feedback: string | null;
          ai_grade: number | null;
          ai_likelihood: number | null;
          ai_reasons: string | null;
          ai_review_at: string | null;
          ai_review_by: string | null;
          answer_text: string | null;
          code_content: string | null;
          code_paths: string[] | null;
          created_at: string;
          diagram_code: string | null;
          id: string;
          question_id: string;
          selected_option: string | null;
          submission_id: string;
          updated_at: string;
          zip_chars_used: number | null;
          zip_path: string | null;
          zip_truncated: boolean | null;
        };
        Insert: {
          ai_detected?: boolean;
          ai_detected_reasons?: string | null;
          ai_detected_score?: number | null;
          ai_feedback?: string | null;
          ai_grade?: number | null;
          ai_likelihood?: number | null;
          ai_reasons?: string | null;
          ai_review_at?: string | null;
          ai_review_by?: string | null;
          answer_text?: string | null;
          code_content?: string | null;
          code_paths?: string[] | null;
          created_at?: string;
          diagram_code?: string | null;
          id?: string;
          question_id: string;
          selected_option?: string | null;
          submission_id: string;
          updated_at?: string;
          zip_chars_used?: number | null;
          zip_path?: string | null;
          zip_truncated?: boolean | null;
        };
        Update: {
          ai_detected?: boolean;
          ai_detected_reasons?: string | null;
          ai_detected_score?: number | null;
          ai_feedback?: string | null;
          ai_grade?: number | null;
          ai_likelihood?: number | null;
          ai_reasons?: string | null;
          ai_review_at?: string | null;
          ai_review_by?: string | null;
          answer_text?: string | null;
          code_content?: string | null;
          code_paths?: string[] | null;
          created_at?: string;
          diagram_code?: string | null;
          id?: string;
          question_id?: string;
          selected_option?: string | null;
          submission_id?: string;
          updated_at?: string;
          zip_chars_used?: number | null;
          zip_path?: string | null;
          zip_truncated?: boolean | null;
        };
        Relationships: [
          {
            foreignKeyName: "workshop_submission_answers_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "workshop_submissions";
            referencedColumns: ["id"];
          },
        ];
      };
      workshop_submission_video_views: {
        Row: {
          submission_id: string;
          video_id: string;
          watched_at: string;
        };
        Insert: {
          submission_id: string;
          video_id: string;
          watched_at?: string;
        };
        Update: {
          submission_id?: string;
          video_id?: string;
          watched_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workshop_submission_video_views_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "workshop_submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workshop_submission_video_views_video_id_fkey";
            columns: ["video_id"];
            isOneToOne: false;
            referencedRelation: "workshop_intro_videos";
            referencedColumns: ["id"];
          },
        ];
      };
      workshop_submissions: {
        Row: {
          ai_detected: boolean;
          ai_detected_reasons: string | null;
          ai_detected_score: number | null;
          ai_feedback: string | null;
          ai_grade: number | null;
          ai_review_at: string | null;
          ai_review_by: string | null;
          attempt_count: number;
          content: string | null;
          created_at: string;
          external_link: string | null;
          file_url: string | null;
          final_grade: number | null;
          group_id: string | null;
          id: string;
          status: string;
          submitted_at: string | null;
          teacher_feedback: string | null;
          updated_at: string;
          user_id: string;
          workshop_id: string;
        };
        Insert: {
          ai_detected?: boolean;
          ai_detected_reasons?: string | null;
          ai_detected_score?: number | null;
          ai_feedback?: string | null;
          ai_grade?: number | null;
          ai_review_at?: string | null;
          ai_review_by?: string | null;
          attempt_count?: number;
          content?: string | null;
          created_at?: string;
          external_link?: string | null;
          file_url?: string | null;
          final_grade?: number | null;
          group_id?: string | null;
          id?: string;
          status?: string;
          submitted_at?: string | null;
          teacher_feedback?: string | null;
          updated_at?: string;
          user_id: string;
          workshop_id: string;
        };
        Update: {
          ai_detected?: boolean;
          ai_detected_reasons?: string | null;
          ai_detected_score?: number | null;
          ai_feedback?: string | null;
          ai_grade?: number | null;
          ai_review_at?: string | null;
          ai_review_by?: string | null;
          attempt_count?: number;
          content?: string | null;
          created_at?: string;
          external_link?: string | null;
          file_url?: string | null;
          final_grade?: number | null;
          group_id?: string | null;
          id?: string;
          status?: string;
          submitted_at?: string | null;
          teacher_feedback?: string | null;
          updated_at?: string;
          user_id?: string;
          workshop_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workshop_submissions_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "workshop_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workshop_submissions_workshop_id_fkey";
            columns: ["workshop_id"];
            isOneToOne: false;
            referencedRelation: "workshops";
            referencedColumns: ["id"];
          },
        ];
      };
      workshops: {
        Row: {
          ai_generated: boolean;
          course_id: string;
          created_at: string;
          created_by: string;
          cut_id: string | null;
          description: string | null;
          due_date: string | null;
          external_link: string | null;
          group_mode: string;
          group_size_max: number;
          group_size_min: number;
          id: string;
          instructions: string | null;
          is_external: boolean;
          max_attempts: number | null;
          max_score: number;
          rubric: Json | null;
          source_content_id: string | null;
          start_date: string | null;
          status: string;
          title: string;
          updated_at: string;
          weight: number;
        };
        Insert: {
          ai_generated?: boolean;
          course_id: string;
          created_at?: string;
          created_by: string;
          cut_id?: string | null;
          description?: string | null;
          due_date?: string | null;
          external_link?: string | null;
          group_mode?: string;
          group_size_max?: number;
          group_size_min?: number;
          id?: string;
          instructions?: string | null;
          is_external?: boolean;
          max_attempts?: number | null;
          max_score?: number;
          rubric?: Json | null;
          source_content_id?: string | null;
          start_date?: string | null;
          status?: string;
          title: string;
          updated_at?: string;
          weight?: number;
        };
        Update: {
          ai_generated?: boolean;
          course_id?: string;
          created_at?: string;
          created_by?: string;
          cut_id?: string | null;
          description?: string | null;
          due_date?: string | null;
          external_link?: string | null;
          group_mode?: string;
          group_size_max?: number;
          group_size_min?: number;
          id?: string;
          instructions?: string | null;
          is_external?: boolean;
          max_attempts?: number | null;
          max_score?: number;
          rubric?: Json | null;
          source_content_id?: string | null;
          start_date?: string | null;
          status?: string;
          title?: string;
          updated_at?: string;
          weight?: number;
        };
        Relationships: [
          {
            foreignKeyName: "workshops_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workshops_cut_id_fkey";
            columns: ["cut_id"];
            isOneToOne: false;
            referencedRelation: "grade_cuts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workshops_source_content_id_fkey";
            columns: ["source_content_id"];
            isOneToOne: false;
            referencedRelation: "generated_contents";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      _audit_jwt_uid: { Args: never; Returns: string };
      _check_content_prompt_overrides_keys: {
        Args: { _overrides: Json };
        Returns: boolean;
      };
      _cron_run_weekly_db_backup: { Args: never; Returns: undefined };
      _error_event_tenant: {
        Args: { _actor_id: string; _course_id: string };
        Returns: string;
      };
      _log_weight_change: {
        Args: {
          _action: string;
          _course_id: string;
          _entity_id: string;
          _entity_name: string;
          _entity_type: string;
          _new_values: Json;
          _previous: Json;
        };
        Returns: undefined;
      };
      _message_audit: {
        Args: {
          _action: string;
          _conversation_id: string;
          _msg_id: string;
          _sender_id: string;
        };
        Returns: undefined;
      };
      _message_was_read_by_other: {
        Args: { _message_id: string };
        Returns: boolean;
      };
      _notification_kind_emails: {
        Args: { _kind: string; _link: string };
        Returns: boolean;
      };
      _user_channel_enabled: {
        Args: { _channel: string; _kind: string; _user_id: string };
        Returns: boolean;
      };
      acknowledge_rejected_ai_grading_job: {
        Args: { _job_id: string };
        Returns: undefined;
      };
      activate_ai_override: { Args: { _code: string }; Returns: Json };
      admin_delete_db_backup: { Args: { _id: string }; Returns: undefined };
      admin_enqueue_db_backup: {
        Args: { _label?: string; _source?: string; _tables: string[] };
        Returns: string;
      };
      admin_list_backupable_tables: {
        Args: never;
        Returns: {
          est_rows: number;
          table_name: string;
        }[];
      };
      admin_list_cron_jobs: {
        Args: never;
        Returns: {
          active: boolean;
          command: string;
          description: string;
          jobid: number;
          jobname: string;
          last_message: string;
          last_run_at: string;
          last_status: string;
          schedule: string;
        }[];
      };
      admin_list_push_subscriptions: {
        Args: never;
        Returns: {
          created_at: string;
          id: string;
          tenant_id: string;
          tenant_name: string;
          updated_at: string;
          user_agent: string;
          user_email: string;
          user_full_name: string;
          user_id: string;
        }[];
      };
      admin_set_cron_job_active: {
        Args: { _active: boolean; _jobid: number };
        Returns: boolean;
      };
      admin_set_cron_job_description: {
        Args: { _description: string; _jobname: string };
        Returns: boolean;
      };
      admin_update_cron_job_schedule: {
        Args: { _jobid: number; _schedule: string };
        Returns: boolean;
      };
      admin_update_my_tenant: {
        Args: {
          _email_domain?: string;
          _icon_color?: string;
          _logo_path?: string;
          _logo_url?: string;
          _name: string;
          _primary_color?: string;
          _secondary_color?: string;
          _text_color?: string;
        };
        Returns: undefined;
      };
      apply_pending_email_changes: { Args: never; Returns: number };
      audit_email_event: {
        Args: {
          p_action: string;
          p_metadata?: Json;
          p_notification_id: string;
          p_severity?: string;
        };
        Returns: undefined;
      };
      can_message: { Args: { _a: string; _b: string }; Returns: boolean };
      cancel_ai_grading_job: { Args: { _job_id: string }; Returns: undefined };
      check_email_alert_threshold: { Args: never; Returns: number };
      check_email_taken: {
        Args: { p_email: string; p_exclude_user_id?: string };
        Returns: boolean;
      };
      check_rate_limit: {
        Args: { p_action: string; p_max: number; p_window_seconds: number };
        Returns: Json;
      };
      claim_ai_override_message: { Args: never; Returns: Json };
      claim_one_ai_grading: {
        Args: { _job_id: string };
        Returns: {
          attempts: number;
          body: Json;
          field_feedback: string;
          field_grade: string;
          field_likelihood: string;
          field_reasons: string;
          id: string;
          invoke_target: string;
          kind: string;
          target_row_id: string;
          target_table: string;
        }[];
      };
      claim_pending_ai_grading: {
        Args: { _limit?: number };
        Returns: {
          attempts: number;
          body: Json;
          field_feedback: string;
          field_grade: string;
          field_likelihood: string;
          field_reasons: string;
          id: string;
          invoke_target: string;
          kind: string;
          target_row_id: string;
          target_table: string;
        }[];
      };
      cleanup_calendar_oauth_states: { Args: never; Returns: number };
      clear_conversation: { Args: { _conv_id: string }; Returns: undefined };
      clear_poll_response: { Args: { _poll_id: string }; Returns: undefined };
      clone_exam: {
        Args: {
          _new_end_time?: string;
          _new_start_time?: string;
          _new_title?: string;
          _source_id: string;
          _target_course_id: string;
        };
        Returns: string;
      };
      clone_project: {
        Args: {
          _new_due_date?: string;
          _new_start_date?: string;
          _new_title?: string;
          _source_id: string;
          _target_course_id: string;
        };
        Returns: string;
      };
      clone_workshop: {
        Args: {
          _new_due_date?: string;
          _new_start_date?: string;
          _new_title?: string;
          _source_id: string;
          _target_course_id: string;
        };
        Returns: string;
      };
      complete_ai_grading: {
        Args: { _error?: string; _job_id: string; _ok: boolean };
        Returns: undefined;
      };
      compute_attendance_code: {
        Args: { p_period: number; p_seed: string };
        Returns: string;
      };
      compute_effective_grade: {
        Args: { p_ai: number; p_final: number; p_override: number };
        Returns: number;
      };
      compute_weighted_grade: { Args: { items: Json }; Returns: number };
      count_ai_errors_last_hour: {
        Args: { _actor_id?: string };
        Returns: number;
      };
      count_ai_errors_per_exam: {
        Args: never;
        Returns: {
          error_count: number;
          exam_id: string;
        }[];
      };
      count_ai_errors_per_project: {
        Args: never;
        Returns: {
          error_count: number;
          project_id: string;
        }[];
      };
      count_ai_errors_per_workshop: {
        Args: never;
        Returns: {
          error_count: number;
          workshop_id: string;
        }[];
      };
      count_unanswered_conversations: { Args: never; Returns: number };
      course_in_my_tenant: { Args: { _course_id: string }; Returns: boolean };
      course_tenant_id: { Args: { _course_id: string }; Returns: string };
      current_ai_override_status: { Args: never; Returns: Json };
      current_tenant_id: { Args: never; Returns: string };
      dispatch_scheduled_messages: { Args: never; Returns: number };
      enqueue_ai_grading: {
        Args: {
          _body: Json;
          _course_id?: string;
          _field_feedback?: string;
          _field_grade?: string;
          _field_likelihood?: string;
          _field_reasons?: string;
          _invoke_target: string;
          _kind: string;
          _target_row_id: string;
          _target_table: string;
        };
        Returns: string;
      };
      error_event_counts: {
        Args: { _tenant_filter?: string };
        Returns: {
          count: number;
          status: string;
        }[];
      };
      generate_course_acta: { Args: { p_course_id: string }; Returns: string };
      get_or_create_calendar_token: {
        Args: never;
        Returns: {
          created_at: string;
          token: string;
        }[];
      };
      has_active_ai_override: { Args: never; Returns: string };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      insert_broadcast_messages: {
        Args: { _body: string; _conv_ids: string[]; _sender_id: string };
        Returns: number;
      };
      is_forum_open: { Args: { _forum_id: string }; Returns: boolean };
      is_module_enabled: {
        Args: { _module: string; _role: string };
        Returns: boolean;
      };
      is_question_course_teacher: {
        Args: { p_kind: string; p_question_id: string; p_user_id: string };
        Returns: boolean;
      };
      is_student_blocked: { Args: { _uid: string }; Returns: boolean };
      is_submission_owner: {
        Args: { p_kind: string; p_submission_id: string; p_user_id: string };
        Returns: boolean;
      };
      is_super_admin: { Args: never; Returns: boolean };
      issue_certificate: {
        Args: { _course_id: string; _final_grade: number; _user_id: string };
        Returns: string;
      };
      list_active_tenants_public: {
        Args: never;
        Returns: {
          id: string;
          logo_path: string;
          logo_url: string;
          name: string;
          primary_color: string;
          slug: string;
        }[];
      };
      list_error_events: {
        Args: {
          _limit?: number;
          _status_filter?: string;
          _tenant_filter?: string;
        };
        Returns: {
          action: string;
          actor_email: string;
          actor_role: string;
          category: string;
          course_name: string;
          created_at: string;
          entity_name: string;
          entity_type: string;
          id: string;
          metadata: Json;
          reviewed_at: string;
          status: string;
          tenant_id: string;
          tenant_name: string;
        }[];
      };
      list_failed_ai_gradings: {
        Args: { _cooldown_minutes?: number; _limit?: number };
        Returns: {
          exam_id: string;
          id: string;
          last_retry_at: string;
          user_id: string;
        }[];
      };
      list_messageable_users: {
        Args: never;
        Returns: {
          email: string;
          full_name: string;
          role_label: string;
          user_id: string;
        }[];
      };
      list_recent_ai_executions: {
        Args: { _limit?: number };
        Returns: {
          action: string;
          actor_email: string;
          actor_id: string;
          created_at: string;
          entity_id: string;
          entity_type: string;
          id: string;
          metadata: Json;
          severity: string;
        }[];
      };
      log_audit_event: {
        Args: {
          p_action: string;
          p_category: string;
          p_course_id?: string;
          p_course_name?: string;
          p_entity_id?: string;
          p_entity_name?: string;
          p_entity_type?: string;
          p_metadata?: Json;
          p_severity?: string;
        };
        Returns: undefined;
      };
      mark_ai_suspicion_reviewed: {
        Args: { p_kind: string; p_submission_id: string; p_unmark?: boolean };
        Returns: undefined;
      };
      mark_all_conversations_read: { Args: never; Returns: number };
      mark_conversation_read: { Args: { _conv_id: string }; Returns: undefined };
      mark_conversation_unread: {
        Args: { _conv_id: string };
        Returns: undefined;
      };
      mark_forum_reply_official: {
        Args: { _official?: boolean; _reply_id: string };
        Returns: undefined;
      };
      mark_project_video_watched: {
        Args: { _submission_id: string; _video_id: string };
        Returns: undefined;
      };
      mark_similarity_pair_reviewed: {
        Args: { p_notes?: string; p_pair_id: string; p_unmark?: boolean };
        Returns: undefined;
      };
      mark_workshop_video_watched: {
        Args: { _submission_id: string; _video_id: string };
        Returns: undefined;
      };
      notify_admins_storage_threshold: { Args: never; Returns: number };
      notify_course_students:
        | {
            Args: {
              _body: string;
              _course_id: string;
              _kind?: string;
              _link?: string;
              _title: string;
            };
            Returns: number;
          }
        | {
            Args: {
              _body: string;
              _course_id: string;
              _kind?: string;
              _link?: string;
              _source_role?: string;
              _title: string;
            };
            Returns: number;
          };
      notify_exam_teachers: {
        Args: {
          _body: string;
          _exam_id: string;
          _link?: string;
          _title: string;
        };
        Returns: number;
      };
      notify_feedback_event: {
        Args: { _actor_role: string; _event: string; _thread_id: string };
        Returns: number;
      };
      notify_students_course_closing: {
        Args: { _days?: number };
        Returns: number;
      };
      notify_students_cut_closing: { Args: { _days?: number }; Returns: number };
      notify_students_exam_starting_soon: {
        Args: { _hours?: number };
        Returns: number;
      };
      notify_students_exam_window_opens: {
        Args: { _lookback_minutes?: number };
        Returns: number;
      };
      notify_students_project_due_soon: {
        Args: { _hours?: number };
        Returns: number;
      };
      notify_students_workshop_due_soon: {
        Args: { _hours?: number };
        Returns: number;
      };
      notify_teachers_daily_summary: { Args: never; Returns: number };
      notify_teachers_pending_exam_notes_before_exam: {
        Args: { _hours?: number };
        Returns: number;
      };
      notify_teachers_pending_grading: { Args: never; Returns: number };
      notify_teachers_workshop_due_tomorrow: { Args: never; Returns: number };
      open_conversation: { Args: { _other: string }; Returns: string };
      poll_is_open: {
        Args: { _poll: Database["public"]["Tables"]["polls"]["Row"] };
        Returns: boolean;
      };
      project_videos_all_watched: {
        Args: { _submission_id: string };
        Returns: boolean;
      };
      purge_audit_logs: {
        Args: never;
        Returns: {
          error_purged: number;
          info_purged: number;
          warning_purged: number;
        }[];
      };
      regenerate_calendar_token: {
        Args: never;
        Returns: {
          created_at: string;
          token: string;
        }[];
      };
      reject_ai_grading_job: {
        Args: { _job_id: string; _reason: string };
        Returns: undefined;
      };
      requeue_ai_grading_job: { Args: { _job_id: string }; Returns: undefined };
      resolve_calendar_token: { Args: { _token: string }; Returns: string };
      resolve_certificate_settings: {
        Args: { _course_id: string };
        Returns: {
          certificate_message: string;
          footer_text: string;
          institution_logo_url: string;
          institution_name: string;
          signature_image_url: string;
          signature_name: string;
          signature_title: string;
        }[];
      };
      revoke_certificate: {
        Args: { _certificate_id: string; _reason?: string };
        Returns: undefined;
      };
      same_tenant: { Args: { _other_user: string }; Returns: boolean };
      set_error_events_status: {
        Args: { _ids: string[]; _status: string };
        Returns: number;
      };
      student_can_write: { Args: { _uid: string }; Returns: boolean };
      student_check_in_attendance: {
        Args: { p_code: string; p_session_id: string };
        Returns: Json;
      };
      system_cron_jobs: {
        Args: never;
        Returns: {
          active: boolean;
          command: string;
          jobname: string;
          last_message: string;
          last_run_at: string;
          last_status: string;
          schedule: string;
        }[];
      };
      system_db_extensions: {
        Args: never;
        Returns: {
          name: string;
          schema: string;
          version: string;
        }[];
      };
      system_edge_function_stats: {
        Args: never;
        Returns: {
          function_name: string;
          last_action: string;
          last_invoked_at: string;
          last_severity: string;
        }[];
      };
      system_storage_usage: {
        Args: never;
        Returns: {
          buckets_count: number;
          db_size_bytes: number;
          objects_count: number;
          objects_size_bytes: number;
        }[];
      };
      teacher_close_attendance_check_in: {
        Args: { p_session_id: string };
        Returns: Json;
      };
      teacher_mark_pending_absent: {
        Args: { p_session_id: string };
        Returns: Json;
      };
      teacher_open_attendance_check_in: {
        Args: {
          p_duration_minutes?: number;
          p_rotation_seconds?: number;
          p_session_id: string;
        };
        Returns: Json;
      };
      tenant_user_counts: { Args: never; Returns: Json };
      toggle_forum_closed: {
        Args: { _close: boolean; _forum_id: string };
        Returns: string;
      };
      toggle_forum_upvote: {
        Args: { _target_id: string; _target_type: string };
        Returns: {
          total: number;
          upvoted: boolean;
        }[];
      };
      trigger_retry_failed_ai_gradings: { Args: never; Returns: undefined };
      verify_certificate: {
        Args: { _short_code: string };
        Returns: {
          course_name: string;
          course_period: string;
          exists_flag: boolean;
          final_grade: number;
          grade_scale_max: number;
          is_revoked: boolean;
          issued_at: string;
          payload_hash: string;
          revoke_reason: string;
          revoked_at: string;
          short_code: string;
          student_full_name: string;
          teacher_names: string[];
          university_logo_url: string;
          university_name: string;
        }[];
      };
      vote_poll_option: {
        Args: { _option_id: string };
        Returns: {
          option_id: string;
          poll_id: string;
          response_id: string;
        }[];
      };
      workshop_videos_all_watched: {
        Args: { _submission_id: string };
        Returns: boolean;
      };
    };
    Enums: {
      app_role: "Admin" | "Docente" | "Estudiante" | "SuperAdmin";
      content_mode: "curso_completo" | "material_individual";
      content_status: "queued" | "processing" | "done" | "failed";
      poll_results_visibility: "always" | "after_close" | "never";
      poll_type: "single" | "multiple" | "slot";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["Admin", "Docente", "Estudiante", "SuperAdmin"],
      content_mode: ["curso_completo", "material_individual"],
      content_status: ["queued", "processing", "done", "failed"],
      poll_results_visibility: ["always", "after_close", "never"],
      poll_type: ["single", "multiple", "slot"],
    },
  },
} as const;
