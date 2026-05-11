export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_model_settings: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          model: string
          provider: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          model: string
          provider: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          model?: string
          provider?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      ai_prompts: {
        Row: {
          course_id: string | null
          created_at: string
          id: string
          system_prompt: string
          updated_at: string
          updated_by: string | null
          use_case: string
        }
        Insert: {
          course_id?: string | null
          created_at?: string
          id?: string
          system_prompt: string
          updated_at?: string
          updated_by?: string | null
          use_case: string
        }
        Update: {
          course_id?: string | null
          created_at?: string
          id?: string
          system_prompt?: string
          updated_at?: string
          updated_by?: string | null
          use_case?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_prompts_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_check_in_state: {
        Row: {
          closes_at: string
          opened_at: string
          rotation_seconds: number
          seed: string
          session_id: string
        }
        Insert: {
          closes_at: string
          opened_at?: string
          rotation_seconds?: number
          seed: string
          session_id: string
        }
        Update: {
          closes_at?: string
          opened_at?: string
          rotation_seconds?: number
          seed?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_check_in_state_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "attendance_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_records: {
        Row: {
          created_at: string
          id: string
          note: string | null
          session_id: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          note?: string | null
          session_id: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          note?: string | null
          session_id?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_records_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "attendance_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_sessions: {
        Row: {
          check_in_open: boolean
          content_class_index: number | null
          content_id: string | null
          course_id: string
          created_at: string
          created_by: string
          cut_id: string | null
          duration_minutes: number | null
          google_event_id: string | null
          id: string
          meeting_url: string | null
          session_date: string
          start_time: string | null
          title: string | null
        }
        Insert: {
          check_in_open?: boolean
          content_class_index?: number | null
          content_id?: string | null
          course_id: string
          created_at?: string
          created_by: string
          cut_id?: string | null
          duration_minutes?: number | null
          google_event_id?: string | null
          id?: string
          meeting_url?: string | null
          session_date: string
          start_time?: string | null
          title?: string | null
        }
        Update: {
          check_in_open?: boolean
          content_class_index?: number | null
          content_id?: string | null
          course_id?: string
          created_at?: string
          created_by?: string
          cut_id?: string | null
          duration_minutes?: number | null
          google_event_id?: string | null
          id?: string
          meeting_url?: string | null
          session_date?: string
          start_time?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attendance_sessions_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "generated_contents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_sessions_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_sessions_cut_id_fkey"
            columns: ["cut_id"]
            isOneToOne: false
            referencedRelation: "grade_cuts"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          actor_role: string | null
          category: string
          course_id: string | null
          course_name: string | null
          created_at: string
          entity_id: string | null
          entity_name: string | null
          entity_type: string | null
          id: string
          metadata: Json
          severity: string
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          actor_role?: string | null
          category: string
          course_id?: string | null
          course_name?: string | null
          created_at?: string
          entity_id?: string | null
          entity_name?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json
          severity?: string
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          actor_role?: string | null
          category?: string
          course_id?: string | null
          course_name?: string | null
          created_at?: string
          entity_id?: string | null
          entity_name?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_oauth_states: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          nonce: string
          origin: string
          provider: string
          state: string
          teacher_id: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          nonce: string
          origin: string
          provider?: string
          state: string
          teacher_id: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          nonce?: string
          origin?: string
          provider?: string
          state?: string
          teacher_id?: string
        }
        Relationships: []
      }
      code_executions: {
        Row: {
          created_at: string
          execution_time_ms: number | null
          exit_code: number | null
          id: string
          language: string
          question_id: string
          source_code: string
          status: string
          stderr: string | null
          stdin: string | null
          stdout: string | null
          submission_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          execution_time_ms?: number | null
          exit_code?: number | null
          id?: string
          language?: string
          question_id: string
          source_code: string
          status?: string
          stderr?: string | null
          stdin?: string | null
          stdout?: string | null
          submission_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          execution_time_ms?: number | null
          exit_code?: number | null
          id?: string
          language?: string
          question_id?: string
          source_code?: string
          status?: string
          stderr?: string | null
          stdin?: string | null
          stdout?: string | null
          submission_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_executions_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "code_executions_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      content_brand_config: {
        Row: {
          author_default: string | null
          id: string
          logo_url: string | null
          primary_color: string
          secondary_color: string
          university_name: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          author_default?: string | null
          id?: string
          logo_url?: string | null
          primary_color?: string
          secondary_color?: string
          university_name?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          author_default?: string | null
          id?: string
          logo_url?: string | null
          primary_color?: string
          secondary_color?: string
          university_name?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      course_enrollments: {
        Row: {
          course_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          course_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          course_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_enrollments_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_enrollments_user_profile_fk"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      course_grading_config: {
        Row: {
          course_id: string
          coursework_weight: number
          final_project_weight: number
          updated_at: string
        }
        Insert: {
          course_id: string
          coursework_weight?: number
          final_project_weight?: number
          updated_at?: string
        }
        Update: {
          course_id?: string
          coursework_weight?: number
          final_project_weight?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_grading_config_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: true
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      course_teachers: {
        Row: {
          course_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          course_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          course_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_teachers_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      courses: {
        Row: {
          attendance_weight: number
          created_at: string
          description: string | null
          end_date: string | null
          exam_weight: number
          grade_scale_max: number
          grade_scale_min: number
          id: string
          language: string
          max_exam_attempts: number
          name: string
          passing_grade: number
          period: string | null
          project_weight: number
          start_date: string | null
          updated_at: string
          workshop_weight: number
        }
        Insert: {
          attendance_weight?: number
          created_at?: string
          description?: string | null
          end_date?: string | null
          exam_weight?: number
          grade_scale_max?: number
          grade_scale_min?: number
          id?: string
          language?: string
          max_exam_attempts?: number
          name: string
          passing_grade?: number
          period?: string | null
          project_weight?: number
          start_date?: string | null
          updated_at?: string
          workshop_weight?: number
        }
        Update: {
          attendance_weight?: number
          created_at?: string
          description?: string | null
          end_date?: string | null
          exam_weight?: number
          grade_scale_max?: number
          grade_scale_min?: number
          id?: string
          language?: string
          max_exam_attempts?: number
          name?: string
          passing_grade?: number
          period?: string | null
          project_weight?: number
          start_date?: string | null
          updated_at?: string
          workshop_weight?: number
        }
        Relationships: []
      }
      exam_assignments: {
        Row: {
          created_at: string
          exam_id: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          exam_id: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          exam_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exam_assignments_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_notes: {
        Row: {
          content: string
          created_at: string
          exam_id: string
          id: string
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          exam_id: string
          id?: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          exam_id?: string
          id?: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exam_notes_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_timer_controls: {
        Row: {
          action: string
          created_at: string
          created_by: string
          exam_id: string
          extra_seconds: number | null
          id: string
          target_user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          created_by: string
          exam_id: string
          extra_seconds?: number | null
          id?: string
          target_user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          created_by?: string
          exam_id?: string
          extra_seconds?: number | null
          id?: string
          target_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "exam_timer_controls_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
        ]
      }
      exams: {
        Row: {
          course_id: string
          created_at: string
          created_by: string
          cut_id: string | null
          description: string | null
          end_time: string
          id: string
          is_external: boolean
          max_attempts: number | null
          max_warnings: number
          navigation_type: string
          parent_exam_id: string | null
          retry_mode: string
          schedule_type: string
          shuffle_enabled: boolean
          source_content_id: string | null
          start_time: string
          time_limit_minutes: number
          title: string
          updated_at: string
          weight: number
        }
        Insert: {
          course_id: string
          created_at?: string
          created_by: string
          cut_id?: string | null
          description?: string | null
          end_time: string
          id?: string
          is_external?: boolean
          max_attempts?: number | null
          max_warnings?: number
          navigation_type?: string
          parent_exam_id?: string | null
          retry_mode?: string
          schedule_type?: string
          shuffle_enabled?: boolean
          source_content_id?: string | null
          start_time: string
          time_limit_minutes?: number
          title: string
          updated_at?: string
          weight?: number
        }
        Update: {
          course_id?: string
          created_at?: string
          created_by?: string
          cut_id?: string | null
          description?: string | null
          end_time?: string
          id?: string
          is_external?: boolean
          max_attempts?: number | null
          max_warnings?: number
          navigation_type?: string
          parent_exam_id?: string | null
          retry_mode?: string
          schedule_type?: string
          shuffle_enabled?: boolean
          source_content_id?: string | null
          start_time?: string
          time_limit_minutes?: number
          title?: string
          updated_at?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "exams_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exams_cut_id_fkey"
            columns: ["cut_id"]
            isOneToOne: false
            referencedRelation: "grade_cuts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exams_parent_exam_id_fkey"
            columns: ["parent_exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exams_source_content_id_fkey"
            columns: ["source_content_id"]
            isOneToOne: false
            referencedRelation: "generated_contents"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback_comments: {
        Row: {
          author_role: string
          body: string
          created_at: string
          id: string
          thread_id: string
          user_id: string
        }
        Insert: {
          author_role?: string
          body: string
          created_at?: string
          id?: string
          thread_id: string
          user_id: string
        }
        Update: {
          author_role?: string
          body?: string
          created_at?: string
          id?: string
          thread_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedback_comments_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "feedback_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback_threads: {
        Row: {
          closed: boolean
          closed_at: string | null
          closed_by: string | null
          created_at: string
          id: string
          parent_kind: string
          question_id: string
          submission_id: string
        }
        Insert: {
          closed?: boolean
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          parent_kind: string
          question_id: string
          submission_id: string
        }
        Update: {
          closed?: boolean
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          parent_kind?: string
          question_id?: string
          submission_id?: string
        }
        Relationships: []
      }
      generated_contents: {
        Row: {
          author: string | null
          course_id: string | null
          created_at: string
          duration_minutes: number | null
          error: string | null
          files: Json
          id: string
          instructions: string | null
          language: string
          modality: string | null
          mode: Database["public"]["Enums"]["content_mode"]
          n_classes: number | null
          raw_output: string | null
          status: Database["public"]["Enums"]["content_status"]
          tags: string[] | null
          teacher_id: string
          topic: string
          updated_at: string
        }
        Insert: {
          author?: string | null
          course_id?: string | null
          created_at?: string
          duration_minutes?: number | null
          error?: string | null
          files?: Json
          id?: string
          instructions?: string | null
          language?: string
          modality?: string | null
          mode: Database["public"]["Enums"]["content_mode"]
          n_classes?: number | null
          raw_output?: string | null
          status?: Database["public"]["Enums"]["content_status"]
          tags?: string[] | null
          teacher_id: string
          topic: string
          updated_at?: string
        }
        Update: {
          author?: string | null
          course_id?: string | null
          created_at?: string
          duration_minutes?: number | null
          error?: string | null
          files?: Json
          id?: string
          instructions?: string | null
          language?: string
          modality?: string | null
          mode?: Database["public"]["Enums"]["content_mode"]
          n_classes?: number | null
          raw_output?: string | null
          status?: Database["public"]["Enums"]["content_status"]
          tags?: string[] | null
          teacher_id?: string
          topic?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "generated_contents_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      grade_cut_items: {
        Row: {
          created_at: string
          cut_id: string
          exam_id: string | null
          id: string
          item_type: string
          project_id: string | null
          project_title: string | null
          weight: number
          workshop_id: string | null
        }
        Insert: {
          created_at?: string
          cut_id: string
          exam_id?: string | null
          id?: string
          item_type: string
          project_id?: string | null
          project_title?: string | null
          weight?: number
          workshop_id?: string | null
        }
        Update: {
          created_at?: string
          cut_id?: string
          exam_id?: string | null
          id?: string
          item_type?: string
          project_id?: string | null
          project_title?: string | null
          weight?: number
          workshop_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "grade_cut_items_cut_id_fkey"
            columns: ["cut_id"]
            isOneToOne: false
            referencedRelation: "grade_cuts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_cut_items_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_cut_items_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_cut_items_workshop_id_fkey"
            columns: ["workshop_id"]
            isOneToOne: false
            referencedRelation: "workshops"
            referencedColumns: ["id"]
          },
        ]
      }
      grade_cuts: {
        Row: {
          attendance_weight: number
          course_id: string
          created_at: string
          end_date: string | null
          exam_weight: number
          id: string
          name: string
          position: number
          project_weight: number
          start_date: string | null
          updated_at: string
          weight: number
          workshop_weight: number
        }
        Insert: {
          attendance_weight?: number
          course_id: string
          created_at?: string
          end_date?: string | null
          exam_weight?: number
          id?: string
          name: string
          position?: number
          project_weight?: number
          start_date?: string | null
          updated_at?: string
          weight?: number
          workshop_weight?: number
        }
        Update: {
          attendance_weight?: number
          course_id?: string
          created_at?: string
          end_date?: string | null
          exam_weight?: number
          id?: string
          name?: string
          position?: number
          project_weight?: number
          start_date?: string | null
          updated_at?: string
          weight?: number
          workshop_weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "grade_cuts_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string
          created_at: string
          exam_id: string | null
          id: string
          kind: string
          link: string | null
          read: boolean
          related_user_id: string | null
          source_role: string | null
          title: string
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          exam_id?: string | null
          id?: string
          kind?: string
          link?: string | null
          read?: boolean
          related_user_id?: string | null
          source_role?: string | null
          title: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          exam_id?: string | null
          id?: string
          kind?: string
          link?: string | null
          read?: boolean
          related_user_id?: string | null
          source_role?: string | null
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string
          id: string
          institutional_email: string
          personal_email: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name: string
          id: string
          institutional_email: string
          personal_email?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: string
          institutional_email?: string
          personal_email?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      project_assignments: {
        Row: {
          created_at: string
          id: string
          project_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          project_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          project_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_assignments_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_courses: {
        Row: {
          course_id: string
          created_at: string
          cut_id: string | null
          id: string
          project_id: string
          weight: number
        }
        Insert: {
          course_id: string
          created_at?: string
          cut_id?: string | null
          id?: string
          project_id: string
          weight?: number
        }
        Update: {
          course_id?: string
          created_at?: string
          cut_id?: string | null
          id?: string
          project_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "project_courses_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_courses_cut_id_fkey"
            columns: ["cut_id"]
            isOneToOne: false
            referencedRelation: "grade_cuts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_courses_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_files: {
        Row: {
          content: string | null
          created_at: string
          description: string | null
          expected_rubric: string | null
          id: string
          language: string | null
          options: Json | null
          points: number
          position: number
          project_id: string
          starter_code: string | null
          title: string
          type: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          description?: string | null
          expected_rubric?: string | null
          id?: string
          language?: string | null
          options?: Json | null
          points?: number
          position?: number
          project_id: string
          starter_code?: string | null
          title: string
          type?: string
        }
        Update: {
          content?: string | null
          created_at?: string
          description?: string | null
          expected_rubric?: string | null
          id?: string
          language?: string | null
          options?: Json | null
          points?: number
          position?: number
          project_id?: string
          starter_code?: string | null
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_files_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_group_members: {
        Row: {
          group_id: string
          joined_at: string
          user_id: string
        }
        Insert: {
          group_id: string
          joined_at?: string
          user_id: string
        }
        Update: {
          group_id?: string
          joined_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "project_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      project_groups: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          project_id: string
          signup_code: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          project_id: string
          signup_code?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          project_id?: string
          signup_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_groups_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_submission_attachments: {
        Row: {
          created_at: string
          file_name: string
          id: string
          mime_type: string | null
          position: number
          project_submission_file_id: string
          size_bytes: number | null
          storage_path: string
        }
        Insert: {
          created_at?: string
          file_name: string
          id?: string
          mime_type?: string | null
          position?: number
          project_submission_file_id: string
          size_bytes?: number | null
          storage_path: string
        }
        Update: {
          created_at?: string
          file_name?: string
          id?: string
          mime_type?: string | null
          position?: number
          project_submission_file_id?: string
          size_bytes?: number | null
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_submission_attachments_project_submission_file_id_fkey"
            columns: ["project_submission_file_id"]
            isOneToOne: false
            referencedRelation: "project_submission_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_submission_attachments_psf_fk"
            columns: ["project_submission_file_id"]
            isOneToOne: false
            referencedRelation: "project_submission_files"
            referencedColumns: ["id"]
          },
        ]
      }
      project_submission_files: {
        Row: {
          ai_feedback: string | null
          ai_grade: number | null
          ai_likelihood: number | null
          ai_reasons: string | null
          content: string | null
          created_at: string
          file_id: string
          id: string
          selected_option: string | null
          submission_id: string
          updated_at: string
          zip_path: string | null
        }
        Insert: {
          ai_feedback?: string | null
          ai_grade?: number | null
          ai_likelihood?: number | null
          ai_reasons?: string | null
          content?: string | null
          created_at?: string
          file_id: string
          id?: string
          selected_option?: string | null
          submission_id: string
          updated_at?: string
          zip_path?: string | null
        }
        Update: {
          ai_feedback?: string | null
          ai_grade?: number | null
          ai_likelihood?: number | null
          ai_reasons?: string | null
          content?: string | null
          created_at?: string
          file_id?: string
          id?: string
          selected_option?: string | null
          submission_id?: string
          updated_at?: string
          zip_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_submission_files_file_fk"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "project_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_submission_files_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "project_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_submission_files_submission_fk"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "project_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_submission_files_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "project_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      project_submissions: {
        Row: {
          ai_detected: boolean
          ai_detected_reasons: string | null
          ai_detected_score: number | null
          ai_feedback: string | null
          ai_grade: number | null
          ai_review_at: string | null
          ai_review_by: string | null
          created_at: string
          defense_at: string | null
          defense_factor: number | null
          defense_notes: string | null
          final_grade: number | null
          group_id: string | null
          id: string
          project_id: string
          repository_url: string | null
          status: string
          submission_grade: number | null
          submitted_at: string | null
          teacher_feedback: string | null
          updated_at: string
          user_id: string
          zip_url: string | null
        }
        Insert: {
          ai_detected?: boolean
          ai_detected_reasons?: string | null
          ai_detected_score?: number | null
          ai_feedback?: string | null
          ai_grade?: number | null
          ai_review_at?: string | null
          ai_review_by?: string | null
          created_at?: string
          defense_at?: string | null
          defense_factor?: number | null
          defense_notes?: string | null
          final_grade?: number | null
          group_id?: string | null
          id?: string
          project_id: string
          repository_url?: string | null
          status?: string
          submission_grade?: number | null
          submitted_at?: string | null
          teacher_feedback?: string | null
          updated_at?: string
          user_id: string
          zip_url?: string | null
        }
        Update: {
          ai_detected?: boolean
          ai_detected_reasons?: string | null
          ai_detected_score?: number | null
          ai_feedback?: string | null
          ai_grade?: number | null
          ai_review_at?: string | null
          ai_review_by?: string | null
          created_at?: string
          defense_at?: string | null
          defense_factor?: number | null
          defense_notes?: string | null
          final_grade?: number | null
          group_id?: string | null
          id?: string
          project_id?: string
          repository_url?: string | null
          status?: string
          submission_grade?: number | null
          submitted_at?: string | null
          teacher_feedback?: string | null
          updated_at?: string
          user_id?: string
          zip_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_submissions_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "project_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          ai_generated: boolean
          course_id: string
          created_at: string
          created_by: string
          cut_id: string | null
          description: string | null
          due_date: string | null
          external_link: string | null
          group_mode: string
          group_size_max: number
          group_size_min: number
          id: string
          instructions: string | null
          is_external: boolean
          max_files: number
          max_score: number
          project_type: string
          source_content_id: string | null
          start_date: string | null
          status: string
          title: string
          updated_at: string
          weight: number
        }
        Insert: {
          ai_generated?: boolean
          course_id: string
          created_at?: string
          created_by: string
          cut_id?: string | null
          description?: string | null
          due_date?: string | null
          external_link?: string | null
          group_mode?: string
          group_size_max?: number
          group_size_min?: number
          id?: string
          instructions?: string | null
          is_external?: boolean
          max_files?: number
          max_score?: number
          project_type?: string
          source_content_id?: string | null
          start_date?: string | null
          status?: string
          title: string
          updated_at?: string
          weight?: number
        }
        Update: {
          ai_generated?: boolean
          course_id?: string
          created_at?: string
          created_by?: string
          cut_id?: string | null
          description?: string | null
          due_date?: string | null
          external_link?: string | null
          group_mode?: string
          group_size_max?: number
          group_size_min?: number
          id?: string
          instructions?: string | null
          is_external?: boolean
          max_files?: number
          max_score?: number
          project_type?: string
          source_content_id?: string | null
          start_date?: string | null
          status?: string
          title?: string
          updated_at?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "projects_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_source_content_id_fkey"
            columns: ["source_content_id"]
            isOneToOne: false
            referencedRelation: "generated_contents"
            referencedColumns: ["id"]
          },
        ]
      }
      push_config: {
        Row: {
          id: number
          send_push_url: string
          trigger_secret: string
          updated_at: string
        }
        Insert: {
          id?: number
          send_push_url: string
          trigger_secret: string
          updated_at?: string
        }
        Update: {
          id?: number
          send_push_url?: string
          trigger_secret?: string
          updated_at?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          p256dh: string
          updated_at: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          p256dh: string
          updated_at?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          p256dh?: string
          updated_at?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      questions: {
        Row: {
          content: string
          created_at: string
          exam_id: string
          expected_rubric: string | null
          id: string
          language: string | null
          options: Json | null
          points: number
          position: number
          starter_code: string | null
          test_cases: Json | null
          type: string
        }
        Insert: {
          content: string
          created_at?: string
          exam_id: string
          expected_rubric?: string | null
          id?: string
          language?: string | null
          options?: Json | null
          points?: number
          position?: number
          starter_code?: string | null
          test_cases?: Json | null
          type: string
        }
        Update: {
          content?: string
          created_at?: string
          exam_id?: string
          expected_rubric?: string | null
          id?: string
          language?: string | null
          options?: Json | null
          points?: number
          position?: number
          starter_code?: string | null
          test_cases?: Json | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "questions_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_events: {
        Row: {
          action: string
          actor_id: string
          created_at: string
          id: number
        }
        Insert: {
          action: string
          actor_id: string
          created_at?: string
          id?: number
        }
        Update: {
          action?: string
          actor_id?: string
          created_at?: string
          id?: number
        }
        Relationships: []
      }
      similarity_pairs: {
        Row: {
          created_at: string
          id: string
          kind: string
          method: string
          question_id: string | null
          reasons: string | null
          ref_id: string
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          score: number
          submission_a: string
          submission_b: string
          user_a: string
          user_b: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          method?: string
          question_id?: string | null
          reasons?: string | null
          ref_id: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          score: number
          submission_a: string
          submission_b: string
          user_a: string
          user_b: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          method?: string
          question_id?: string | null
          reasons?: string | null
          ref_id?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          score?: number
          submission_a?: string
          submission_b?: string
          user_a?: string
          user_b?: string
        }
        Relationships: []
      }
      submissions: {
        Row: {
          ai_detected: boolean
          ai_detected_reasons: string | null
          ai_detected_score: number | null
          ai_grade: number | null
          ai_review_at: string | null
          ai_review_by: string | null
          answers: Json
          created_at: string
          exam_id: string
          extra_seconds: number
          final_override_grade: number | null
          focus_warnings: number
          id: string
          started_at: string
          status: string
          submitted_at: string | null
          teacher_feedback: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_detected?: boolean
          ai_detected_reasons?: string | null
          ai_detected_score?: number | null
          ai_grade?: number | null
          ai_review_at?: string | null
          ai_review_by?: string | null
          answers?: Json
          created_at?: string
          exam_id: string
          extra_seconds?: number
          final_override_grade?: number | null
          focus_warnings?: number
          id?: string
          started_at?: string
          status?: string
          submitted_at?: string | null
          teacher_feedback?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_detected?: boolean
          ai_detected_reasons?: string | null
          ai_detected_score?: number | null
          ai_grade?: number | null
          ai_review_at?: string | null
          ai_review_by?: string | null
          answers?: Json
          created_at?: string
          exam_id?: string
          extra_seconds?: number
          final_override_grade?: number | null
          focus_warnings?: number
          id?: string
          started_at?: string
          status?: string
          submitted_at?: string | null
          teacher_feedback?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "submissions_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
        ]
      }
      teacher_google_tokens: {
        Row: {
          access_token: string | null
          calendar_id: string | null
          calendar_name: string | null
          created_at: string
          expires_at: string | null
          google_email: string | null
          provider: string
          provider_email: string | null
          refresh_token: string
          teacher_id: string
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          calendar_id?: string | null
          calendar_name?: string | null
          created_at?: string
          expires_at?: string | null
          google_email?: string | null
          provider?: string
          provider_email?: string | null
          refresh_token: string
          teacher_id: string
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          calendar_id?: string | null
          calendar_name?: string | null
          created_at?: string
          expires_at?: string | null
          google_email?: string | null
          provider?: string
          provider_email?: string | null
          refresh_token?: string
          teacher_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      workshop_assignments: {
        Row: {
          created_at: string
          id: string
          user_id: string
          workshop_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          user_id: string
          workshop_id: string
        }
        Update: {
          created_at?: string
          id?: string
          user_id?: string
          workshop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workshop_assignments_workshop_id_fkey"
            columns: ["workshop_id"]
            isOneToOne: false
            referencedRelation: "workshops"
            referencedColumns: ["id"]
          },
        ]
      }
      workshop_group_members: {
        Row: {
          group_id: string
          joined_at: string
          user_id: string
        }
        Insert: {
          group_id: string
          joined_at?: string
          user_id: string
        }
        Update: {
          group_id?: string
          joined_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workshop_group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "workshop_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      workshop_groups: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          signup_code: string
          workshop_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          signup_code?: string
          workshop_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          signup_code?: string
          workshop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workshop_groups_workshop_id_fkey"
            columns: ["workshop_id"]
            isOneToOne: false
            referencedRelation: "workshops"
            referencedColumns: ["id"]
          },
        ]
      }
      workshop_questions: {
        Row: {
          content: string
          created_at: string
          expected_rubric: string | null
          id: string
          language: string | null
          options: Json | null
          points: number
          position: number
          starter_code: string | null
          test_cases: Json | null
          type: string
          workshop_id: string
        }
        Insert: {
          content: string
          created_at?: string
          expected_rubric?: string | null
          id?: string
          language?: string | null
          options?: Json | null
          points?: number
          position?: number
          starter_code?: string | null
          test_cases?: Json | null
          type: string
          workshop_id: string
        }
        Update: {
          content?: string
          created_at?: string
          expected_rubric?: string | null
          id?: string
          language?: string | null
          options?: Json | null
          points?: number
          position?: number
          starter_code?: string | null
          test_cases?: Json | null
          type?: string
          workshop_id?: string
        }
        Relationships: []
      }
      workshop_submission_answers: {
        Row: {
          ai_detected: boolean
          ai_detected_reasons: string | null
          ai_detected_score: number | null
          ai_feedback: string | null
          ai_grade: number | null
          answer_text: string | null
          code_content: string | null
          created_at: string
          diagram_code: string | null
          id: string
          question_id: string
          selected_option: string | null
          submission_id: string
          updated_at: string
        }
        Insert: {
          ai_detected?: boolean
          ai_detected_reasons?: string | null
          ai_detected_score?: number | null
          ai_feedback?: string | null
          ai_grade?: number | null
          answer_text?: string | null
          code_content?: string | null
          created_at?: string
          diagram_code?: string | null
          id?: string
          question_id: string
          selected_option?: string | null
          submission_id: string
          updated_at?: string
        }
        Update: {
          ai_detected?: boolean
          ai_detected_reasons?: string | null
          ai_detected_score?: number | null
          ai_feedback?: string | null
          ai_grade?: number | null
          answer_text?: string | null
          code_content?: string | null
          created_at?: string
          diagram_code?: string | null
          id?: string
          question_id?: string
          selected_option?: string | null
          submission_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workshop_submission_answers_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "workshop_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      workshop_submissions: {
        Row: {
          ai_detected: boolean
          ai_detected_reasons: string | null
          ai_detected_score: number | null
          ai_feedback: string | null
          ai_grade: number | null
          ai_review_at: string | null
          ai_review_by: string | null
          content: string | null
          created_at: string
          external_link: string | null
          file_url: string | null
          final_grade: number | null
          group_id: string | null
          id: string
          status: string
          submitted_at: string | null
          teacher_feedback: string | null
          updated_at: string
          user_id: string
          workshop_id: string
        }
        Insert: {
          ai_detected?: boolean
          ai_detected_reasons?: string | null
          ai_detected_score?: number | null
          ai_feedback?: string | null
          ai_grade?: number | null
          ai_review_at?: string | null
          ai_review_by?: string | null
          content?: string | null
          created_at?: string
          external_link?: string | null
          file_url?: string | null
          final_grade?: number | null
          group_id?: string | null
          id?: string
          status?: string
          submitted_at?: string | null
          teacher_feedback?: string | null
          updated_at?: string
          user_id: string
          workshop_id: string
        }
        Update: {
          ai_detected?: boolean
          ai_detected_reasons?: string | null
          ai_detected_score?: number | null
          ai_feedback?: string | null
          ai_grade?: number | null
          ai_review_at?: string | null
          ai_review_by?: string | null
          content?: string | null
          created_at?: string
          external_link?: string | null
          file_url?: string | null
          final_grade?: number | null
          group_id?: string | null
          id?: string
          status?: string
          submitted_at?: string | null
          teacher_feedback?: string | null
          updated_at?: string
          user_id?: string
          workshop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workshop_submissions_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "workshop_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workshop_submissions_workshop_id_fkey"
            columns: ["workshop_id"]
            isOneToOne: false
            referencedRelation: "workshops"
            referencedColumns: ["id"]
          },
        ]
      }
      workshops: {
        Row: {
          ai_generated: boolean
          course_id: string
          created_at: string
          created_by: string
          cut_id: string | null
          description: string | null
          due_date: string | null
          external_link: string | null
          group_mode: string
          group_size_max: number
          group_size_min: number
          id: string
          instructions: string | null
          is_external: boolean
          max_score: number
          rubric: Json | null
          source_content_id: string | null
          start_date: string | null
          status: string
          title: string
          updated_at: string
          weight: number
        }
        Insert: {
          ai_generated?: boolean
          course_id: string
          created_at?: string
          created_by: string
          cut_id?: string | null
          description?: string | null
          due_date?: string | null
          external_link?: string | null
          group_mode?: string
          group_size_max?: number
          group_size_min?: number
          id?: string
          instructions?: string | null
          is_external?: boolean
          max_score?: number
          rubric?: Json | null
          source_content_id?: string | null
          start_date?: string | null
          status?: string
          title: string
          updated_at?: string
          weight?: number
        }
        Update: {
          ai_generated?: boolean
          course_id?: string
          created_at?: string
          created_by?: string
          cut_id?: string | null
          description?: string | null
          due_date?: string | null
          external_link?: string | null
          group_mode?: string
          group_size_max?: number
          group_size_min?: number
          id?: string
          instructions?: string | null
          is_external?: boolean
          max_score?: number
          rubric?: Json | null
          source_content_id?: string | null
          start_date?: string | null
          status?: string
          title?: string
          updated_at?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "workshops_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workshops_cut_id_fkey"
            columns: ["cut_id"]
            isOneToOne: false
            referencedRelation: "grade_cuts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workshops_source_content_id_fkey"
            columns: ["source_content_id"]
            isOneToOne: false
            referencedRelation: "generated_contents"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _audit_jwt_uid: { Args: never; Returns: string }
      check_email_taken: {
        Args: { p_email: string; p_exclude_user_id?: string }
        Returns: boolean
      }
      check_rate_limit: {
        Args: { p_action: string; p_max: number; p_window_seconds: number }
        Returns: Json
      }
      cleanup_calendar_oauth_states: { Args: never; Returns: number }
      compute_attendance_code: {
        Args: { p_period: number; p_seed: string }
        Returns: string
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_question_course_teacher: {
        Args: { p_kind: string; p_question_id: string; p_user_id: string }
        Returns: boolean
      }
      is_submission_owner: {
        Args: { p_kind: string; p_submission_id: string; p_user_id: string }
        Returns: boolean
      }
      log_audit_event: {
        Args: {
          p_action: string
          p_category: string
          p_course_id?: string
          p_course_name?: string
          p_entity_id?: string
          p_entity_name?: string
          p_entity_type?: string
          p_metadata?: Json
          p_severity?: string
        }
        Returns: undefined
      }
      mark_ai_suspicion_reviewed: {
        Args: { p_kind: string; p_submission_id: string; p_unmark?: boolean }
        Returns: undefined
      }
      mark_similarity_pair_reviewed: {
        Args: { p_notes?: string; p_pair_id: string; p_unmark?: boolean }
        Returns: undefined
      }
      notify_course_students:
        | {
            Args: {
              _body: string
              _course_id: string
              _kind?: string
              _link?: string
              _title: string
            }
            Returns: number
          }
        | {
            Args: {
              _body: string
              _course_id: string
              _kind?: string
              _link?: string
              _source_role?: string
              _title: string
            }
            Returns: number
          }
      notify_exam_teachers: {
        Args: {
          _body: string
          _exam_id: string
          _link?: string
          _title: string
        }
        Returns: number
      }
      notify_feedback_event: {
        Args: { _actor_role: string; _event: string; _thread_id: string }
        Returns: number
      }
      notify_students_course_closing: {
        Args: { _days?: number }
        Returns: number
      }
      notify_students_cut_closing: { Args: { _days?: number }; Returns: number }
      notify_teachers_pending_grading: { Args: never; Returns: number }
      notify_teachers_workshop_due_tomorrow: { Args: never; Returns: number }
      student_check_in_attendance: {
        Args: { p_code: string; p_session_id: string }
        Returns: Json
      }
      teacher_close_attendance_check_in: {
        Args: { p_session_id: string }
        Returns: Json
      }
      teacher_mark_pending_absent: {
        Args: { p_session_id: string }
        Returns: Json
      }
      teacher_open_attendance_check_in: {
        Args: {
          p_duration_minutes?: number
          p_rotation_seconds?: number
          p_session_id: string
        }
        Returns: Json
      }
    }
    Enums: {
      app_role: "Admin" | "Docente" | "Estudiante"
      content_mode: "curso_completo" | "material_individual"
      content_status: "queued" | "processing" | "done" | "failed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["Admin", "Docente", "Estudiante"],
      content_mode: ["curso_completo", "material_individual"],
      content_status: ["queued", "processing", "done", "failed"],
    },
  },
} as const
