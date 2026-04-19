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
        ]
      }
      notifications: {
        Row: {
          id: string
          user_id: string
          title: string
          body: string
          kind: string
          link: string | null
          read: boolean
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          title: string
          body: string
          kind?: string
          link?: string | null
          read?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          title?: string
          body?: string
          kind?: string
          link?: string | null
          read?: boolean
          created_at?: string
        }
        Relationships: []
      }
      courses: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          period: string | null
          start_date: string | null
          end_date: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          period?: string | null
          start_date?: string | null
          end_date?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          period?: string | null
          start_date?: string | null
          end_date?: string | null
          updated_at?: string
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
      exams: {
        Row: {
          course_id: string
          created_at: string
          created_by: string
          description: string | null
          end_time: string
          id: string
          navigation_type: string
          parent_exam_id: string | null
          shuffle_enabled: boolean
          start_time: string
          time_limit_minutes: number
          title: string
          updated_at: string
        }
        Insert: {
          course_id: string
          created_at?: string
          created_by: string
          description?: string | null
          end_time: string
          id?: string
          navigation_type?: string
          parent_exam_id?: string | null
          shuffle_enabled?: boolean
          start_time: string
          time_limit_minutes?: number
          title: string
          updated_at?: string
        }
        Update: {
          course_id?: string
          created_at?: string
          created_by?: string
          description?: string | null
          end_time?: string
          id?: string
          navigation_type?: string
          parent_exam_id?: string | null
          shuffle_enabled?: boolean
          start_time?: string
          time_limit_minutes?: number
          title?: string
          updated_at?: string
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
            foreignKeyName: "exams_parent_exam_id_fkey"
            columns: ["parent_exam_id"]
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
      questions: {
        Row: {
          content: string
          created_at: string
          exam_id: string
          expected_rubric: string | null
          id: string
          options: Json | null
          points: number
          position: number
          type: string
        }
        Insert: {
          content: string
          created_at?: string
          exam_id: string
          expected_rubric?: string | null
          id?: string
          options?: Json | null
          points?: number
          position?: number
          type: string
        }
        Update: {
          content?: string
          created_at?: string
          exam_id?: string
          expected_rubric?: string | null
          id?: string
          options?: Json | null
          points?: number
          position?: number
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
      submissions: {
        Row: {
          ai_grade: number | null
          answers: Json
          created_at: string
          exam_id: string
          final_override_grade: number | null
          focus_warnings: number
          id: string
          started_at: string
          status: string
          submitted_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_grade?: number | null
          answers?: Json
          created_at?: string
          exam_id: string
          final_override_grade?: number | null
          focus_warnings?: number
          id?: string
          started_at?: string
          status?: string
          submitted_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_grade?: number | null
          answers?: Json
          created_at?: string
          exam_id?: string
          final_override_grade?: number | null
          focus_warnings?: number
          id?: string
          started_at?: string
          status?: string
          submitted_at?: string | null
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
      exam_timer_controls: {
        Row: {
          id: string
          exam_id: string
          target_user_id: string | null
          action: string
          extra_seconds: number
          created_by: string
          created_at: string
        }
        Insert: {
          id?: string
          exam_id: string
          target_user_id?: string | null
          action: string
          extra_seconds?: number
          created_by: string
          created_at?: string
        }
        Update: {
          id?: string
          exam_id?: string
          target_user_id?: string | null
          action?: string
          extra_seconds?: number
          created_by?: string
          created_at?: string
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
      code_executions: {
        Row: {
          id: string
          submission_id: string | null
          question_id: string
          user_id: string
          language: string
          source_code: string
          stdin: string | null
          stdout: string | null
          stderr: string | null
          exit_code: number | null
          execution_time_ms: number | null
          status: string
          created_at: string
        }
        Insert: {
          id?: string
          submission_id?: string | null
          question_id: string
          user_id: string
          language?: string
          source_code: string
          stdin?: string | null
          stdout?: string | null
          stderr?: string | null
          exit_code?: number | null
          execution_time_ms?: number | null
          status?: string
          created_at?: string
        }
        Update: {
          id?: string
          submission_id?: string | null
          question_id?: string
          user_id?: string
          language?: string
          source_code?: string
          stdin?: string | null
          stdout?: string | null
          stderr?: string | null
          exit_code?: number | null
          execution_time_ms?: number | null
          status?: string
          created_at?: string
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
      workshops: {
        Row: {
          id: string
          course_id: string
          created_by: string
          title: string
          description: string | null
          instructions: string | null
          external_link: string | null
          ai_generated: boolean
          due_date: string | null
          rubric: Json | null
          max_score: number
          status: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          course_id: string
          created_by: string
          title: string
          description?: string | null
          instructions?: string | null
          external_link?: string | null
          ai_generated?: boolean
          due_date?: string | null
          rubric?: Json | null
          max_score?: number
          status?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          course_id?: string
          created_by?: string
          title?: string
          description?: string | null
          instructions?: string | null
          external_link?: string | null
          ai_generated?: boolean
          due_date?: string | null
          rubric?: Json | null
          max_score?: number
          status?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workshops_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      workshop_assignments: {
        Row: {
          id: string
          workshop_id: string
          user_id: string
          created_at: string
        }
        Insert: {
          id?: string
          workshop_id: string
          user_id: string
          created_at?: string
        }
        Update: {
          id?: string
          workshop_id?: string
          user_id?: string
          created_at?: string
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
      workshop_submissions: {
        Row: {
          id: string
          workshop_id: string
          user_id: string
          content: string | null
          file_url: string | null
          external_link: string | null
          ai_grade: number | null
          ai_feedback: string | null
          final_grade: number | null
          teacher_feedback: string | null
          status: string
          submitted_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          workshop_id: string
          user_id: string
          content?: string | null
          file_url?: string | null
          external_link?: string | null
          ai_grade?: number | null
          ai_feedback?: string | null
          final_grade?: number | null
          teacher_feedback?: string | null
          status?: string
          submitted_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          workshop_id?: string
          user_id?: string
          content?: string | null
          file_url?: string | null
          external_link?: string | null
          ai_grade?: number | null
          ai_feedback?: string | null
          final_grade?: number | null
          teacher_feedback?: string | null
          status?: string
          submitted_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workshop_submissions_workshop_id_fkey"
            columns: ["workshop_id"]
            isOneToOne: false
            referencedRelation: "workshops"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      notify_course_students: {
        Args: {
          _course_id: string
          _title: string
          _body: string
          _kind: string
          _link: string
        }
        Returns: number
      }
    }
    Enums: {
      app_role: "Admin" | "Docente" | "Estudiante"
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
    },
  },
} as const
